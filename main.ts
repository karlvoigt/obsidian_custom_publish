import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

// --- PLUGIN SETTINGS STORAGE ---
interface DeployerSettings {
	workingDirectory: string;
	publishDirectory: string;
	previouslySelectedFiles: string[];
}

const DEFAULT_SETTINGS: DeployerSettings = {
	workingDirectory: 'Drafts',
	publishDirectory: 'publish',
	previouslySelectedFiles: []
}

export default class MasterDeployerPlugin extends Plugin {
	settings: DeployerSettings;

	async onload() {
		await this.loadSettings();

		// Sidebar Icon: Open Deployment Dashboard
		this.addRibbonIcon('rocket', 'Open Deployment Dashboard', () => {
			new DeployModal(this.app, this).open();
		});

		// Command 1: Open Deployment Dashboard
		this.addCommand({
			id: 'open-deploy-modal',
			name: 'Open Deployment Dashboard',
			callback: () => {
				new DeployModal(this.app, this).open();
			}
		});

		// Command 2: Open Unpublish Dashboard
		this.addCommand({
			id: 'open-unpublish-modal',
			name: 'Open Unpublish Dashboard',
			callback: () => {
				new UnpublishModal(this.app, this).open();
			}
		});

		// Command 3: Deploy Current Active File Only
		this.addCommand({
			id: 'deploy-current-file',
			name: 'Deploy Current Active File',
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.path.startsWith(this.settings.workingDirectory + '/')) {
					this.executeDeploymentEngine([activeFile]);
				} else {
					new Notice("The active document does not live inside your configured working directory.");
				}
			}
		});

		// Command 4: Batch Redeploy Previous Selections
		this.addCommand({
			id: 'redeploy-previous-selection',
			name: 'Redeploy All Previously Selected Files',
			callback: () => {
				const filesToDeploy: TFile[] = [];
				this.settings.previouslySelectedFiles.forEach(filePath => {
					const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
					if (abstractFile instanceof TFile) {
						filesToDeploy.push(abstractFile);
					}
				});

				if (filesToDeploy.length > 0) {
					this.executeDeploymentEngine(filesToDeploy);
				} else {
					new Notice("No valid previously selected documents found to synchronize.");
				}
			}
		});

		// Command 5: Standalone Asset Cleanup Optimization Routine
		this.addCommand({
			id: 'run-asset-cleanup',
			name: 'Clean Orphaned Attachments from Publish Folder',
			callback: () => {
				this.executeAttachmentCleanupEngine();
			}
		});

		this.addSettingTab(new DeployerSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- SYSTEM ENGINE 1: SYNCHRONIZATION ENGINE ---
	executeDeploymentEngine(filesToDeploy: TFile[]) {
		const vaultBasePath = (this.app.vault.adapter as any).getBasePath();
		const publishDirAbs = path.join(vaultBasePath, this.settings.publishDirectory);
		const attachmentsDirAbs = path.join(publishDirAbs, 'attachments');

		let successCount = 0;

		try {
			if (!fs.existsSync(publishDirAbs)) fs.mkdirSync(publishDirAbs, { recursive: true });
			if (!fs.existsSync(attachmentsDirAbs)) fs.mkdirSync(attachmentsDirAbs, { recursive: true });

			filesToDeploy.forEach(file => {
				const relPath = file.path.substring(this.settings.workingDirectory.length + 1);
				const destPathAbs = path.join(publishDirAbs, relPath);
				
				const destDir = path.dirname(destPathAbs);
				if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

				const srcPathAbs = path.join(vaultBasePath, file.path);
				fs.copyFileSync(srcPathAbs, destPathAbs);
				successCount++;

				const cache = this.app.metadataCache.getFileCache(file);
				const linkedAssets = [...(cache?.embeds || []), ...(cache?.links || [])];

				linkedAssets.forEach(linkObj => {
					const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkObj.link, file.path);
					
					if (targetFile && targetFile.extension !== 'md') {
						const assetSrcAbs = path.join(vaultBasePath, targetFile.path);
						const assetDestAbs = path.join(attachmentsDirAbs, targetFile.name);
						
						if (!fs.existsSync(assetDestAbs) || fs.statSync(assetSrcAbs).mtimeMs > fs.statSync(assetDestAbs).mtimeMs) {
							fs.copyFileSync(assetSrcAbs, assetDestAbs);
						}
					}
				});
			});

			new Notice(`Successfully deployed ${successCount} files and their assets.`);
		} catch (error) {
			console.error("Deployment Engine Error:", error);
			new Notice("Deployment execution failed.");
		}
	}

	// --- SYSTEM ENGINE 2: RECURSIVE ATTACHMENT CLEANUP ENGINE ---
	executeAttachmentCleanupEngine() {
		const vaultBasePath = (this.app.vault.adapter as any).getBasePath();
		const publishDirAbs = path.join(vaultBasePath, this.settings.publishDirectory);
		const attachmentsDirAbs = path.join(publishDirAbs, 'attachments');

		if (!fs.existsSync(attachmentsDirAbs)) {
			return; // No attachments exist yet, skip execution safely
		}

		try {
			const activeAssetNames = new Set<string>();

			// Step A: Parse active entries by reading files currently living inside the staged publish tree
			this.settings.previouslySelectedFiles.forEach(filePath => {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					// Verify if it actively exists inside our publish disk path before counting references
					const relPath = file.path.substring(this.settings.workingDirectory.length + 1);
					const publishedFileAbs = path.join(publishDirAbs, relPath);

					if (fs.existsSync(publishedFileAbs)) {
						const cache = this.app.metadataCache.getFileCache(file);
						const links = [...(cache?.embeds || []), ...(cache?.links || [])];
						links.forEach(l => {
							const target = this.app.metadataCache.getFirstLinkpathDest(l.link, file.path);
							if (target && target.extension !== 'md') {
								activeAssetNames.add(target.name);
							}
						});
					}
				}
			});

			// Step B: Walk the disk store of the attachments staging folder and filter orphaned allocations
			const filesOnDisk = fs.readdirSync(attachmentsDirAbs);
			let deleteCount = 0;

			filesOnDisk.forEach(fileName => {
				// Avoid cleaning out standard project metadata components if present
				if (fileName === '.DS_Store') return;

				if (!activeAssetNames.has(fileName)) {
					const targetOrphanAbs = path.join(attachmentsDirAbs, fileName);
					fs.unlinkSync(targetOrphanAbs);
					deleteCount++;
				}
			});

			if (deleteCount > 0) {
				new Notice(`Garbage Collector: Removed ${deleteCount} unused attachment assets.`);
			} else {
				new Notice("Garbage Collector: Build files optimization up-to-date.");
			}
		} catch (error) {
			console.error("Cleanup Optimization Engine Failure:", error);
			new Notice("Asset cleanup extraction encounter trace failure.");
		}
	}
}

// --- PANEL UI A: DEPLOYMENT SELECTION PANEL ---
class DeployModal extends Modal {
	plugin: MasterDeployerPlugin;
	selectedFiles: Set<string>;

	constructor(app: App, plugin: MasterDeployerPlugin) {
		super(app);
		this.plugin = plugin;
		this.selectedFiles = new Set(this.plugin.settings.previouslySelectedFiles);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'Deployment Dashboard' });
		contentEl.createEl('p', { text: `Select files from '${this.plugin.settings.workingDirectory}' to stage for publishing.`, cls: 'setting-item-description' });

		const allFiles = this.app.vault.getMarkdownFiles();
		const workingFiles = allFiles.filter(file => file.path.startsWith(this.plugin.settings.workingDirectory + '/'));

		if (workingFiles.length === 0) {
			contentEl.createEl('p', { text: 'No files found in the configured working directory.', cls: 'has-error' });
			return;
		}

		const listContainer = contentEl.createDiv({ cls: 'deployer-file-list' });
		listContainer.style.maxHeight = '300px';
		listContainer.style.overflowY = 'auto';
		listContainer.style.border = '1px solid var(--background-modifier-border)';
		listContainer.style.padding = '10px';
		listContainer.style.borderRadius = '5px';
		listContainer.style.marginBottom = '20px';

		workingFiles.forEach(file => {
			const row = listContainer.createDiv({ cls: 'deployer-checkbox-row' });
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.marginBottom = '5px';

			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.style.marginRight = '10px';
			
			if (this.selectedFiles.has(file.path)) checkbox.checked = true;
			
			const displayName = file.path.substring(this.plugin.settings.workingDirectory.length + 1);
			row.createEl('label', { text: displayName });

			checkbox.addEventListener('change', (e) => {
				if ((e.target as HTMLInputElement).checked) {
					this.selectedFiles.add(file.path);
				} else {
					this.selectedFiles.delete(file.path);
				}
			});
		});

		const btnContainer = contentEl.createDiv();
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';

		const submitBtn = btnContainer.createEl('button', { text: 'Deploy Selected Files', cls: 'mod-cta' });
		submitBtn.addEventListener('click', async () => {
			this.plugin.settings.previouslySelectedFiles = Array.from(this.selectedFiles);
			await this.plugin.saveSettings();

			const targets = workingFiles.filter(f => this.selectedFiles.has(f.path));
			this.plugin.executeDeploymentEngine(targets);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- PANEL UI B: UNPUBLISH SELECTION PANEL ---
class UnpublishModal extends Modal {
	plugin: MasterDeployerPlugin;
	filesToUnpublish: Set<string> = new Set();

	constructor(app: App, plugin: MasterDeployerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Unpublish Dashboard' });
		contentEl.createEl('p', { text: 'Select currently staged files to delete from the Vercel publish tracking stream.', cls: 'setting-item-description' });

		const vaultBasePath = (this.app.vault.adapter as any).getBasePath();
		const publishDirAbs = path.join(vaultBasePath, this.plugin.settings.publishDirectory);

		// Scan tracking history mapping against files physically existing on disk
		const activeTrackedFiles = this.plugin.settings.previouslySelectedFiles.filter(filePath => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) return false;
			const relPath = file.path.substring(this.plugin.settings.workingDirectory.length + 1);
			return fs.existsSync(path.join(publishDirAbs, relPath));
		});

		if (activeTrackedFiles.length === 0) {
			contentEl.createEl('p', { text: 'There are no active files currently staged inside the publish directory.', cls: 'setting-item-description' });
			return;
		}

		const listContainer = contentEl.createDiv({ cls: 'deployer-file-list' });
		listContainer.style.maxHeight = '300px';
		listContainer.style.overflowY = 'auto';
		listContainer.style.border = '1px solid var(--background-modifier-border)';
		listContainer.style.padding = '10px';
		listContainer.style.borderRadius = '5px';
		listContainer.style.marginBottom = '20px';

		activeTrackedFiles.forEach(filePath => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath) as TFile;
			const row = listContainer.createDiv();
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.marginBottom = '5px';

			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.style.marginRight = '10px';

			const displayName = file.path.substring(this.plugin.settings.workingDirectory.length + 1);
			row.createEl('label', { text: displayName });

			checkbox.addEventListener('change', (e) => {
				if ((e.target as HTMLInputElement).checked) {
					this.filesToUnpublish.add(filePath);
				} else {
					this.filesToUnpublish.delete(filePath);
				}
			});
		});

		const btnContainer = contentEl.createDiv();
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';

		const removeBtn = btnContainer.createEl('button', { text: 'Unpublish Selected Files', cls: 'mod-warning' });
		removeBtn.style.backgroundColor = 'var(--text-error)';
		removeBtn.style.color = 'white';
		
		removeBtn.addEventListener('click', async () => {
			let unpublishCount = 0;

			activeTrackedFiles.forEach(filePath => {
				if (this.filesToUnpublish.has(filePath)) {
					const file = this.plugin.app.vault.getAbstractFileByPath(filePath) as TFile;
					const relPath = file.path.substring(this.plugin.settings.workingDirectory.length + 1);
					const publishedFileAbs = path.join(publishDirAbs, relPath);

					// Delete Markdown File from the Vercel Directory
					if (fs.existsSync(publishedFileAbs)) {
						fs.unlinkSync(publishedFileAbs);
						unpublishCount++;
					}

					// Remove from internal deployment tracking configurations completely
					this.plugin.settings.previouslySelectedFiles = this.plugin.settings.previouslySelectedFiles.filter(item => item !== filePath);
				}
			});

			await this.plugin.saveSettings();
			new Notice(`Successfully removed ${unpublishCount} tracking documents from staging output directory.`);

			// AUTOMATIC CLEANUP: Cascade asset scan sweep straight after unpublish task drops reference links
			this.plugin.executeAttachmentCleanupEngine();
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- SETTINGS MAPPING TAB ---
class DeployerSettingTab extends PluginSettingTab {
	plugin: MasterDeployerPlugin;

	constructor(app: App, plugin: MasterDeployerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Master Deployer Configuration' });

		new Setting(containerEl)
			.setName('Working Directory')
			.setDesc('Source folder containing working draft notes (e.g., Drafts).')
			.addText(text => text
				.setPlaceholder('Drafts')
				.setValue(this.plugin.settings.workingDirectory)
				.onChange(async (value) => {
					this.plugin.settings.workingDirectory = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Publish Directory')
			.setDesc('Target output directory for staging code files (e.g., publish).')
			.addText(text => text
				.setPlaceholder('publish')
				.setValue(this.plugin.settings.publishDirectory)
				.onChange(async (value) => {
					this.plugin.settings.publishDirectory = value.trim();
					await this.plugin.saveSettings();
				}));
	}
}