const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Dynamic import for node-fetch to work with modern Node.js and ESM compatibility
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

let mainWindow;
const WEBSITE_URL = 'https://axolotlsmp.com';
const BACKUP_FOLDER = path.join(os.homedir(), 'AxolotlSMP_Backups');

function log(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (mainWindow) {
        mainWindow.webContents.send('debug-log', {
            timestamp: new Date().toLocaleTimeString(),
            type,
            message
        });
    }
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
    });

    mainWindow.setMenuBarVisibility(false);
    await mainWindow.loadFile('renderer/index.html');
    log('Application started');
}

ipcMain.handle('select-directory', async () => {
    log('Manual directory selection initiated');
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Your Mods Folder',
        buttonLabel: 'Select Mods Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        log(`Manually selected directory: ${selectedPath}`);
        mainWindow.webContents.send('status', `Selected directory: ${selectedPath}`);
        mainWindow.webContents.send('directory-selected', selectedPath);
        return selectedPath;
    }

    mainWindow.webContents.send('error', 'No directory selected');
    return null;
});

ipcMain.on('start-update', async (event, customPath = null) => {
    try {
        log('Starting update process');
        let modsPath = customPath || await findModsPath();
        if (!modsPath) return; // Wait for user to select instance if multiple are found

        mainWindow.webContents.send('status', 'Backing up mods...');
        await backupMods(modsPath);

        mainWindow.webContents.send('status', 'Syncing mods...');
        await syncMods(modsPath);

        mainWindow.webContents.send('complete', true);
        mainWindow.webContents.send('status', 'Update completed successfully!');
    } catch (error) {
        log(error.message, 'error');
        mainWindow.webContents.send('error', error.message);
    }
});

async function findModsPath() {
    const home = os.homedir();
    let prismPath;

    switch (process.platform) {
        case 'win32': // Windows
            prismPath = path.join(home, 'AppData', 'Roaming', 'PrismLauncher', 'instances');
            break;
        case 'darwin': // macOS
            prismPath = path.join(home, 'Library', 'Application Support', 'PrismLauncher', 'instances');
            break;
        case 'linux': // Linux
            prismPath = path.join(home, '.local', 'share', 'PrismLauncher', 'instances');
            break;
        default:
            throw new Error('Unsupported operating system');
    }

    if (!fs.existsSync(prismPath)) {
        throw new Error('Prism Launcher not found. Please ensure it is installed.');
    }

    const instances = fs.readdirSync(prismPath)
        .filter(dir => dir.toLowerCase().includes('axolotlsmp'));

    if (instances.length === 0) {
        throw new Error('No AxolotlSMP instances found');
    } else if (instances.length > 1) {
        const instanceOptions = instances.map(instance => ({
            name: instance,
            path: path.join(prismPath, instance, 'minecraft', 'mods')
        }));
        mainWindow.webContents.send('multiple-instances', instanceOptions);
        return null; // Wait for user selection
    }

    return path.join(prismPath, instances[0], 'minecraft', 'mods');
}

async function backupMods(modsPath) {
    if (!fs.existsSync(BACKUP_FOLDER)) fs.mkdirSync(BACKUP_FOLDER, { recursive: true });
    const backupPath = path.join(BACKUP_FOLDER, 'mods_backup');
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true });
    fs.mkdirSync(backupPath);

    log('Backing up current mods...');
    fs.readdirSync(modsPath).forEach(file => {
        fs.copyFileSync(path.join(modsPath, file), path.join(backupPath, file));
    });
}

async function syncMods(modsPath) {
    log('Fetching mod list from server');
    const response = await fetch(`${WEBSITE_URL}/api/mods`);
    if (!response.ok) throw new Error(`Server returned ${response.status}: ${response.statusText}`);

    const { mods: serverMods } = await response.json();
    const localMods = fs.existsSync(modsPath) ? fs.readdirSync(modsPath) : [];
    log(`Scanning directory for differences...`);
    log(`Local Mods: ${localMods.join(', ')}`);
    log(`Server Mods: ${serverMods.join(', ')}`);

    for (const mod of localMods) {
        if (!serverMods.includes(mod)) {
            fs.unlinkSync(path.join(modsPath, mod));
            log(`Removed outdated mod: ${mod}`);
        }
    }

    for (let i = 0; i < serverMods.length; i++) {
        const mod = serverMods[i];
        mainWindow.webContents.send('progress', {
            current: i + 1,
            total: serverMods.length,
            currentMod: mod
        });
        if (!localMods.includes(mod)) {
            await downloadMod(mod, modsPath);
        }
    }
    log('Update completed successfully', 'success');
}

async function downloadMod(modName, targetPath) {
    const modPath = path.join(targetPath, modName);
    log(`Downloading ${modName}...`);

    const response = await fetch(`${WEBSITE_URL}/cdn/${modName}`);
    if (!response.ok) throw new Error(`Failed to download ${modName}: ${response.statusText}`);

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(modPath, Buffer.from(arrayBuffer));
    log(`Downloaded ${modName}`, 'success');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});