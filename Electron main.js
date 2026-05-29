const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(app.getPath('userData'), 'litty-chat.db');
let db;
let SQL;

async function initDatabase() {
    SQL = await initSqlJs();
    try {
        const data = await fs.readFile(dbPath);
        db = new SQL.Database(data);
    } catch (e) {
        db = new SQL.Database();
    }
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            model TEXT DEFAULT 'gpt-3.5-turbo',
            system_prompt TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            tokens_used INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            nickname TEXT,
            email TEXT,
            avatar_path TEXT,
            api_key TEXT,
            api_base TEXT DEFAULT 'https://api.openai.com/v1',
            model TEXT DEFAULT 'gpt-3.5-turbo',
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );
    `);
    await saveDatabase();
}

async function saveDatabase() {
    if (!db) return;
    const data = db.export();
    await fs.writeFile(dbPath, Buffer.from(data));
}

function dbQuery(sql, params = []) {
    const stmt = db.prepare(sql);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function dbRun(sql, params = []) {
    db.run(sql, params);
    // 修复：使用更可靠的方式获取 lastID
    let lastID = 0;
    try {
        const result = dbQuery('SELECT last_insert_rowid() as lastID');
        lastID = result[0]?.lastID || 0;
    } catch (e) {
        // INSERT OR REPLACE 等操作可能没有 lastID
    }
    return { lastID, changes: db.getRowsModified() };
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'Electron preload.js')
        },
        show: false,
        backgroundColor: '#0a0a1a'
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        try {
            const rows = dbQuery('SELECT value FROM config WHERE key = ?', ['window-state']);
            if (rows.length > 0) {
                const state = JSON.parse(rows[0].value);
                if (state.maximized) mainWindow.maximize();
                else mainWindow.setBounds(state.bounds);
            }
        } catch (e) {}
    });

    mainWindow.on('close', async () => {
        const bounds = mainWindow.getBounds();
        const state = JSON.stringify({ bounds, maximized: mainWindow.isMaximized() });
        dbRun('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['window-state', state]);
        await saveDatabase();
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    await initDatabase();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
    if (db) { await saveDatabase(); db.close(); }
    if (process.platform !== 'darwin') app.quit();
});

setInterval(async () => { if (db) await saveDatabase(); }, 30000);

ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window-maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); });

const avatarDir = path.join(app.getPath('userData'), 'avatars');

ipcMain.handle('save-avatar', async (event, { userId, buffer }) => {
    await fs.mkdir(avatarDir, { recursive: true });
    const filePath = path.join(avatarDir, `${userId}.png`);
    await fs.writeFile(filePath, Buffer.from(buffer));
    return filePath;
});

ipcMain.handle('get-avatar-path', async (event, userId) => {
    const userAvatar = path.join(avatarDir, `${userId}.png`);
    try { 
        await fs.access(userAvatar); 
        return userAvatar; 
    } catch { 
        // 修复：返回 null 而不是可能不存在的默认头像路径
        return null; 
    }
});

ipcMain.handle('db-query', (event, { sql, params = [] }) => {
    try { return dbQuery(sql, params); }
    catch (err) { console.error('DB Query Error:', err); throw err; }
});

ipcMain.handle('db-run', async (event, { sql, params = [] }) => {
    try {
        const result = dbRun(sql, params);
        await saveDatabase();
        return result;
    } catch (err) { console.error('DB Run Error:', err); throw err; }
});

ipcMain.handle('get-config', (event, key) => {
    try { const rows = dbQuery('SELECT value FROM config WHERE key = ?', [key]); return rows.length > 0 ? rows[0].value : null; }
    catch (e) { return null; }
});

ipcMain.handle('set-config', async (event, { key, value }) => {
    dbRun('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
    await saveDatabase();
    return true;
});

ipcMain.handle('export-chat', async (event, { sessionId, format }) => {
    const messages = dbQuery('SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at', [sessionId]);
    const sessions = dbQuery('SELECT title FROM sessions WHERE id = ?', [sessionId]);
    const title = sessions.length > 0 ? sessions[0].title : '未命名对话';
    
    let content, ext;
    if (format === 'md') {
        content = `# ${title}\n\n` + messages.map(m => `**${m.role === 'user' ? '用户' : 'AI'}** (${new Date(m.created_at).toLocaleString()}):\n${m.content}\n`).join('\n---\n');
        ext = 'md';
    } else {
        content = JSON.stringify({ title, messages }, null, 2);
        ext = 'json';
    }
    
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `chat-export-${sessionId}.${ext}`,
        filters: [{ name: format === 'md' ? 'Markdown' : 'JSON', extensions: [ext] }]
    });
    
    if (filePath) { await fs.writeFile(filePath, content, 'utf8'); return { success: true, path: filePath }; }
    return { success: false };
});

ipcMain.handle('get-app-version', () => app.getVersion());