import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database } from 'sql.js';

const COOKIE_NAME = 'WorkosCursorSessionToken';

export class CursorAuthService {
    private static sqlInit: Awaited<ReturnType<typeof initSqlJs>> | undefined;

    static getCursorUserDataPath(context: vscode.ExtensionContext): string {
        // .../Cursor/User/globalStorage/<extensionId> -> .../Cursor
        return path.resolve(context.globalStorageUri.fsPath, '..', '..');
    }

    /** Candidate Cursor user-data dirs (Electron profile roots). */
    static getCursorUserDataPathCandidates(context: vscode.ExtensionContext): string[] {
        const home = os.homedir();
        const candidates = [this.getCursorUserDataPath(context)];

        if (process.platform === 'win32') {
            candidates.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor'));
        } else if (process.platform === 'darwin') {
            candidates.push(path.join(home, 'Library', 'Application Support', 'Cursor'));
        } else {
            candidates.push(path.join(home, '.config', 'Cursor'));
            candidates.push(path.join(home, '.cursor'));
        }

        return [...new Set(candidates.map((p) => path.resolve(p)))];
    }

    static getSearchRootDirectories(context: vscode.ExtensionContext): string[] {
        const config = vscode.workspace.getConfiguration('cursorPriceTracking');
        const manual = config.get<string>('cookiesSearchPath', '').trim();
        const roots: string[] = [];

        if (manual) {
            const expanded = manual.startsWith('~/')
                ? path.join(os.homedir(), manual.slice(2))
                : manual === '~'
                  ? os.homedir()
                  : manual;
            roots.push(path.resolve(expanded));
        }

        for (const dir of this.getCursorUserDataPathCandidates(context)) {
            if (!roots.includes(dir)) {
                roots.push(dir);
            }
        }

        return roots;
    }

    static findCookiesDatabaseAtRoot(userDataPath: string): string | null {
        const candidates = [
            path.join(userDataPath, 'Network', 'Cookies'),
            path.join(userDataPath, 'Cookies'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    static findCookiesFileInDirectory(rootDir: string): string | null {
        if (!fs.existsSync(rootDir)) {
            return null;
        }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(rootDir);
        } catch {
            return null;
        }

        if (stat.isFile()) {
            return path.basename(rootDir) === 'Cookies' ? rootDir : null;
        }

        if (!stat.isDirectory()) {
            return null;
        }

        const direct = this.findCookiesDatabaseAtRoot(rootDir);
        if (direct) {
            return direct;
        }

        return this.walkForCookiesFile(rootDir, 4);
    }

    private static walkForCookiesFile(dir: string, depthRemaining: number): string | null {
        if (depthRemaining < 0) {
            return null;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'Cookies') {
                return path.join(dir, entry.name);
            }
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === 'node_modules' || entry.name === 'Cache') {
                continue;
            }
            const found = this.walkForCookiesFile(path.join(dir, entry.name), depthRemaining - 1);
            if (found) {
                return found;
            }
        }

        return null;
    }

    static diagnose(context: vscode.ExtensionContext): string {
        const lines: string[] = [
            `App: ${vscode.env.appName}`,
            `Extension path: ${context.extensionPath}`,
        ];

        for (const userDataPath of this.getSearchRootDirectories(context)) {
            const cookiesPath = this.findCookiesFileInDirectory(userDataPath);
            lines.push(`Search root: ${userDataPath}`);
            lines.push(`  Cookies file: ${cookiesPath ?? '(not found)'}`);
        }

        const sqlWasm = path.join(context.extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
        lines.push(`sql.js wasm: ${fs.existsSync(sqlWasm) ? sqlWasm : '(missing — run npm install)'}`);

        return lines.join('\n');
    }

    static describeSessionReadFailure(context: vscode.ExtensionContext): string {
        if (!this.isRunningInCursor()) {
            return '当前不是在 Cursor 里运行（例如在 VS Code 里 F5），无法读取 Cursor 的 Cookie。请在 Cursor 中安装/调试本扩展。';
        }

        const userDataPaths = this.getSearchRootDirectories(context);
        const cookiesPaths = userDataPaths
            .map((dir) => this.findCookiesFileInDirectory(dir))
            .filter((p): p is string => p !== null);

        if (cookiesPaths.length === 0) {
            return `未找到 Cookie 数据库。已检查：${userDataPaths.join('；')}。请确认已在 Cursor 登录账号。`;
        }

        return '已找到 Cookie 文件，但没有可读的 WorkosCursorSessionToken（可能未登录，或 Cookie 被系统加密）。可尝试命令「Reload Session from Cursor」，或在设置里填写 cursorPriceTracking.sessionToken 作为备用。';
    }

    static isRunningInCursor(): boolean {
        return vscode.env.appName.toLowerCase().includes('cursor');
    }

    static formatCookieHeader(tokenOrCookie: string): string {
        const trimmed = tokenOrCookie.trim();
        if (!trimmed) {
            return '';
        }
        if (trimmed.includes('=')) {
            return trimmed;
        }
        return `${COOKIE_NAME}=${trimmed}`;
    }

    static async resolveSessionCookie(context: vscode.ExtensionContext): Promise<string | null> {
        const config = vscode.workspace.getConfiguration('cursorPriceTracking');
        const manualOverride = config.get<string>('sessionToken', '').trim();
        if (manualOverride) {
            return this.formatCookieHeader(manualOverride);
        }

        if (!this.isRunningInCursor()) {
            return null;
        }

        return this.readWorkosSessionTokenFromCookies(context);
    }

    private static async getSql(extensionPath: string): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
        if (!this.sqlInit) {
            const sqlJsDist = path.join(extensionPath, 'node_modules', 'sql.js', 'dist');
            this.sqlInit = await initSqlJs({
                locateFile: (file: string) => path.join(sqlJsDist, file),
            });
        }
        return this.sqlInit;
    }

    private static findAnyCookiesDatabasePath(context: vscode.ExtensionContext): string | null {
        for (const root of this.getSearchRootDirectories(context)) {
            const cookiesPath = this.findCookiesFileInDirectory(root);
            if (cookiesPath) {
                return cookiesPath;
            }
        }
        return null;
    }

    private static copySqliteDatabaseToTemp(basePath: string): string {
        const tmpBase = path.join(
            os.tmpdir(),
            `cursor-price-tracking-cookies-${process.pid}-${Date.now()}`
        );
        for (const suffix of ['', '-wal', '-shm']) {
            const source = basePath + suffix;
            if (fs.existsSync(source)) {
                fs.copyFileSync(source, tmpBase + suffix);
            }
        }
        return tmpBase;
    }

    private static queryCookieValue(db: Database): { token: string | null; encryptedOnly: boolean } {
        const statement = db.prepare(
            `SELECT value, encrypted_value FROM cookies
             WHERE name = ?
             ORDER BY creation_utc DESC
             LIMIT 1`
        );
        try {
            statement.bind([COOKIE_NAME]);
            if (!statement.step()) {
                return { token: null, encryptedOnly: false };
            }
            const row = statement.getAsObject() as { value?: string; encrypted_value?: Uint8Array };
            if (row.value && row.value.length > 0) {
                return { token: row.value, encryptedOnly: false };
            }
            if (row.encrypted_value && row.encrypted_value.length > 0) {
                return { token: null, encryptedOnly: true };
            }
            return { token: null, encryptedOnly: false };
        } finally {
            statement.free();
        }
    }

    static async readWorkosSessionTokenFromCookies(context: vscode.ExtensionContext): Promise<string | null> {
        const cookiesPath = this.findAnyCookiesDatabasePath(context);
        if (!cookiesPath) {
            return null;
        }

        const tempDbPath = this.copySqliteDatabaseToTemp(cookiesPath);
        let db: Database | undefined;

        try {
            const SQL = await this.getSql(context.extensionPath);
            const buffer = fs.readFileSync(tempDbPath);
            db = new SQL.Database(buffer);
            const { token, encryptedOnly } = this.queryCookieValue(db);
            if (encryptedOnly) {
                console.warn(
                    'WorkosCursorSessionToken is encrypted in the Cookies DB; set cursorPriceTracking.sessionToken manually.'
                );
            }
            return token ? this.formatCookieHeader(token) : null;
        } catch (error) {
            console.error('Failed to read Cursor session cookie:', error);
            return null;
        } finally {
            db?.close();
            for (const suffix of ['', '-wal', '-shm']) {
                const file = tempDbPath + suffix;
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                }
            }
        }
    }
}
