import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database } from 'sql.js';
import { decryptChromiumCookieValue, resolveLocalStatePath } from './chromiumCookieDecrypt';

const COOKIE_NAME = 'WorkosCursorSessionToken';

export type SessionTokenInspectResult =
    | { status: 'ok'; cookiesDbPath: string }
    | { status: 'no_cookies_file' }
    | { status: 'missing'; cookiesDbPath: string }
    | { status: 'encrypted'; cookiesDbPath: string };

export class CursorAuthService {
    private static sqlInit: Awaited<ReturnType<typeof initSqlJs>> | undefined;

    static getCursorUserDataPath(context: vscode.ExtensionContext): string {
        // .../Cursor/User/globalStorage/<extensionId> -> .../Cursor
        return path.resolve(context.globalStorageUri.fsPath, '..', '..', '..');
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
            for (const flatpakId of [
                'io.io.cursor',
                'io.github.cursor.Cursor',
                'com.cursor.Cursor',
                'dev.cursor.Cursor',
            ]) {
                candidates.push(path.join(home, '.var', 'app', flatpakId, 'config', 'Cursor'));
            }
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

    static listCookiesDatabasePathsAtRoot(userDataPath: string): string[] {
        const paths: string[] = [];
        const network = path.join(userDataPath, 'Network', 'Cookies');
        const legacy = path.join(userDataPath, 'Cookies');
        if (fs.existsSync(network)) {
            paths.push(network);
        }
        if (fs.existsSync(legacy) && !paths.includes(legacy)) {
            paths.push(legacy);
        }
        return paths;
    }

    static findCookiesDatabaseAtRoot(userDataPath: string): string | null {
        const paths = this.listCookiesDatabasePathsAtRoot(userDataPath);
        return paths[0] ?? null;
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

        const walked = this.walkForCookiesFile(rootDir, 4);
        return walked;
    }

    static listAllCookiesDatabasePaths(context: vscode.ExtensionContext): string[] {
        const paths: string[] = [];
        for (const root of this.getSearchRootDirectories(context)) {
            if (!fs.existsSync(root)) {
                continue;
            }
            for (const p of this.listCookiesDatabasePathsAtRoot(root)) {
                if (!paths.includes(p)) {
                    paths.push(p);
                }
            }
            const walked = this.walkForCookiesFile(root, 4);
            if (walked && !paths.includes(walked)) {
                paths.push(walked);
            }
        }
        return paths;
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

        return '已找到 Cookie 文件，但读不到 WorkosCursorSessionToken：请在 cursor.com 登录、尝试 Network/Cookies，或在设置填写 sessionToken。';
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
        const all = this.listAllCookiesDatabasePaths(context);
        return all[0] ?? null;
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

    private static queryCookieValue(db: Database, cookiesDbPath: string): { token: string | null; encryptedOnly: boolean; missing: boolean } {
        const statement = db.prepare(
            `SELECT value, encrypted_value FROM cookies
             WHERE name = ?
             ORDER BY creation_utc DESC
             LIMIT 1`
        );
        try {
            statement.bind([COOKIE_NAME]);
            if (!statement.step()) {
                return { token: null, encryptedOnly: false, missing: true };
            }
            const row = statement.getAsObject() as { value?: string; encrypted_value?: Uint8Array };
            if (row.value && row.value.length > 0) {
                return { token: row.value, encryptedOnly: false, missing: false };
            }
            if (row.encrypted_value && row.encrypted_value.length > 0) {
                const localStatePath = resolveLocalStatePath(cookiesDbPath);
                const decrypted = decryptChromiumCookieValue(row.encrypted_value, localStatePath);
                if (decrypted) {
                    return { token: decrypted, encryptedOnly: false, missing: false };
                }
                return { token: null, encryptedOnly: true, missing: false };
            }
            return { token: null, encryptedOnly: false, missing: false };
        } finally {
            statement.free();
        }
    }

    static async inspectSessionToken(context: vscode.ExtensionContext): Promise<SessionTokenInspectResult> {
        const paths = this.listAllCookiesDatabasePaths(context);
        if (paths.length === 0) {
            return { status: 'no_cookies_file' };
        }

        const SQL = await this.getSql(context.extensionPath);
        let lastMissing: string | null = null;
        let lastEncrypted: string | null = null;

        for (const cookiesPath of paths) {
            const tempDbPath = this.copySqliteDatabaseToTemp(cookiesPath);
            let db: Database | undefined;
            try {
                const buffer = fs.readFileSync(tempDbPath);
                db = new SQL.Database(buffer);
                const { token, encryptedOnly, missing } = this.queryCookieValue(db, cookiesPath);
                if (token) {
                    return { status: 'ok', cookiesDbPath: cookiesPath };
                }
                if (missing) {
                    lastMissing = cookiesPath;
                } else if (encryptedOnly) {
                    lastEncrypted = cookiesPath;
                }
            } catch {
                // try next db
            } finally {
                db?.close();
                this.cleanupTempDb(tempDbPath);
            }
        }

        if (lastEncrypted) {
            return { status: 'encrypted', cookiesDbPath: lastEncrypted };
        }
        if (lastMissing) {
            return { status: 'missing', cookiesDbPath: lastMissing };
        }
        return { status: 'missing', cookiesDbPath: paths[0] };
    }

    private static cleanupTempDb(tempDbPath: string): void {
        for (const suffix of ['', '-wal', '-shm']) {
            const file = tempDbPath + suffix;
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
    }

    static async readWorkosSessionTokenFromCookies(context: vscode.ExtensionContext): Promise<string | null> {
        const paths = this.listAllCookiesDatabasePaths(context);
        if (paths.length === 0) {
            return null;
        }

        const SQL = await this.getSql(context.extensionPath);

        for (const cookiesPath of paths) {
            const tempDbPath = this.copySqliteDatabaseToTemp(cookiesPath);
            let db: Database | undefined;

            try {
                const buffer = fs.readFileSync(tempDbPath);
                db = new SQL.Database(buffer);
                const { token, encryptedOnly } = this.queryCookieValue(db, cookiesPath);
                if (encryptedOnly) {
                    console.warn(`WorkosCursorSessionToken encrypted in ${cookiesPath}`);
                }
                if (token) {
                    return this.formatCookieHeader(token);
                }
            } catch (error) {
                console.error(`Failed to read cookies DB ${cookiesPath}:`, error);
            } finally {
                db?.close();
                this.cleanupTempDb(tempDbPath);
            }
        }

        return null;
    }
}
