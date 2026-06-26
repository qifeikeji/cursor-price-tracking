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

    private static async getSql(extensionPath: string) {
        if (!this.sqlInit) {
            const sqlJsDist = path.join(extensionPath, 'node_modules', 'sql.js', 'dist');
            this.sqlInit = initSqlJs({
                locateFile: (file: string) => path.join(sqlJsDist, file),
            });
        }
        return this.sqlInit;
    }

    private static findCookiesDatabasePath(userDataPath: string): string | null {
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

    private static queryCookieValue(db: Database): string | null {
        const statement = db.prepare(
            `SELECT value, encrypted_value FROM cookies
             WHERE name = ? AND (host_key LIKE '%cursor.com%' OR host_key LIKE '%.cursor.com%')
             ORDER BY creation_utc DESC
             LIMIT 1`
        );
        try {
            statement.bind([COOKIE_NAME]);
            if (!statement.step()) {
                return null;
            }
            const row = statement.getAsObject() as { value?: string; encrypted_value?: Uint8Array };
            if (row.value && row.value.length > 0) {
                return row.value;
            }
            if (row.encrypted_value && row.encrypted_value.length > 0) {
                return null;
            }
            return null;
        } finally {
            statement.free();
        }
    }

    static async readWorkosSessionTokenFromCookies(context: vscode.ExtensionContext): Promise<string | null> {
        const userDataPath = this.getCursorUserDataPath(context);
        const cookiesPath = this.findCookiesDatabasePath(userDataPath);
        if (!cookiesPath) {
            return null;
        }

        const tempDbPath = this.copySqliteDatabaseToTemp(cookiesPath);
        let db: Database | undefined;

        try {
            const SQL = await this.getSql(context.extensionPath);
            const buffer = fs.readFileSync(tempDbPath);
            db = new SQL.Database(buffer);
            const token = this.queryCookieValue(db);
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
