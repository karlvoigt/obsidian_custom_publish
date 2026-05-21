import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

// --- PLUGIN SETTINGS STORAGE ---
interface DeployerSettings {
	workingDirectory: string;
	publishDirectory: string;
	previouslySelectedFiles: string[]; // Stores state across app reboots
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

		// Icon 1: Open the Interactive Checklist Panel
		this.addRibbonIcon('rocket', 'Open Deployment Dashboard', () => {
			new DeployModal(this.app, this).open();
		});

		// Command 1: Open Dashboard
		this.addCommand({
			id: 'open-deploy-modal',
			name: 'Open Deployment Dashboard',
			callback: () => {
				new DeployModal(this.app, this).open();
			}
		});

		// Command 2: Deploy Current File Only
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

		// Command 3: Batch Deploy Previous Selections Immediately
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

		this.addSettingTab(new DeployerSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- CENTRALIZED DISK SYNCHRONIZATION ENGINE ---
	executeDeploymentEngine(filesToDeploy: TFile[]) {
		const vaultBasePath = (this.app.vault.adapter as any).getBasePath();
		const publishDirAbs = path.join(vaultBasePath, this.settings.publishDirectory);
		const attachmentsDirAbs = path.join(publishDirAbs, 'attachments');

		let successCount = 0;

		try {
			if (!fs.existsSync(publishDirAbs)) fs.mkdirSync(publishDirAbs, { recursive: true });
			if (!fs.existsSync(attachmentsDirAbs)) fs.mkdirSync(attachmentsDirAbs, { recursive: true });

			filesToDeploy.forEach(file => {
				// 1. Mirror Folder Structure
				const relPath = file.path.substring(this.settings.workingDirectory.length + 1);
				const destPathAbs = path.join(publishDirAbs, relPath);
				
				const destDir = path.dirname(destPathAbs);
				if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

				// 2. Synchronize Markdown File
				const srcPathAbs = path.join(vaultBasePath, file.path);
				fs.copyFileSync(srcPathAbs, destPathAbs);
				successCount++;

				// 3. Resolve and Move Extracted Assets
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
			new Notice("Deployment execution failed. Check developers console.");
		}
	}
}

// --- INTERACTIVE CHECKLIST DASHBOARD DIALOG ---
class DeployModal extends Modal {
	plugin: MasterDeployerPlugin;
	selectedFiles: Set<string>;

	constructor(app: App, plugin: MasterDeployerPlugin) {
		super(app);
		this.plugin = plugin;
		// Initialize the set using the stored array from previous selections
		this.selectedFiles = new Set(this.plugin.settings.previouslySelectedFiles);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'Deployment Dashboard' });
		contentEl.createEl('p', { text: `Select files from '${this.plugin.settings.workingDirectory}' to stage for publishing. Selections are remembered automatically.`, cls: 'setting-item-description' });

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
			
			// RESTORE CHECKED STATE: Check if file was selected in the past
			if (this.selectedFiles.has(file.path)) {
				checkbox.checked = true;
			}
			
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
			// PERSIST SELECTIONS: Convert the set back to array and save to settings
			this.plugin.settings.previouslySelectedFiles = Array.from(this.selectedFiles);
			await this.plugin.saveSettings();

			const targets = workingFiles.filter(f => this.selectedFiles.has(f.path));
			this.plugin.executeDeploymentEngine(targets);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// --- SETTINGS CONTROL INTERFACE ---
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