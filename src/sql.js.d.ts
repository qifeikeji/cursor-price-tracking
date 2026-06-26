declare module 'sql.js' {
    export class Database {
        constructor(data?: ArrayLike<number> | Buffer | null);
        prepare(sql: string): Statement;
        close(): void;
    }

    export interface Statement {
        bind(values?: unknown[]): boolean;
        step(): boolean;
        getAsObject(): Record<string, unknown>;
        free(): void;
    }

    export interface SqlJsStatic {
        Database: typeof Database;
    }

    export interface InitSqlJsConfig {
        locateFile?: (file: string) => string;
    }

    export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
