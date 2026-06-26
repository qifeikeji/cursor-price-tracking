import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorAuthService, SessionTokenInspectResult } from './cursorAuth';

export interface CookieScanResult {
    cookiesFilePath: string | null;
    foundInManualFolder: boolean;
    manualFolder: string | null;
    searchedRoots: { path: string; exists: boolean; note: string }[];
    sessionInspect: SessionTokenInspectResult | null;
}

const CONFIG_SECTION = 'cursorPriceTracking';
const KEY_SCAN_STATUS = 'cookiesScanStatus';
const KEY_SEARCH_PATH = 'cookiesSearchPath';

function expandHome(input: string): string {
    const trimmed = input.trim();
    if (trimmed.startsWith('~/')) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    if (trimmed === '~') {
        return os.homedir();
    }
    return trimmed;
}

export function resolveManualCookiesSearchFolder(): string | null {
    const manual = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(KEY_SEARCH_PATH, '').trim();
    if (!manual) {
        return null;
    }
    return path.resolve(expandHome(manual));
}

export function scanForCookiesFile(context: vscode.ExtensionContext): CookieScanResult {
    const manualFolder = resolveManualCookiesSearchFolder();
    const autoRoots = CursorAuthService.getCursorUserDataPathCandidates(context);
    const searchOrder: string[] = [];

    if (manualFolder) {
        searchOrder.push(manualFolder);
    }
    for (const root of autoRoots) {
        if (!searchOrder.some((p) => path.resolve(p) === path.resolve(root))) {
            searchOrder.push(root);
        }
    }

    const searchedRoots: CookieScanResult['searchedRoots'] = [];
    let cookiesFilePath: string | null = null;
    let foundInManualFolder = false;

    for (const root of searchOrder) {
        const exists = fs.existsSync(root);
        if (!exists) {
            searchedRoots.push({ path: root, exists: false, note: '路径不存在' });
            continue;
        }

        const found = CursorAuthService.findCookiesFileInDirectory(root);
        if (found) {
            searchedRoots.push({ path: root, exists: true, note: `已找到 → ${found}` });
            if (!cookiesFilePath) {
                cookiesFilePath = found;
                if (manualFolder && path.resolve(root) === path.resolve(manualFolder)) {
                    foundInManualFolder = true;
                }
            }
        } else {
            searchedRoots.push({ path: root, exists: true, note: '已搜索，未找到 Cookies 文件' });
        }
    }

    if (manualFolder && cookiesFilePath) {
        const manualResolved = path.resolve(manualFolder);
        const relative = path.relative(manualResolved, cookiesFilePath);
        foundInManualFolder = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    return {
        cookiesFilePath,
        foundInManualFolder: Boolean(manualFolder && cookiesFilePath && foundInManualFolder),
        manualFolder,
        searchedRoots,
        sessionInspect: null,
    };
}

export async function scanForCookiesFileAsync(
    context: vscode.ExtensionContext
): Promise<CookieScanResult> {
    const base = scanForCookiesFile(context);
    const sessionInspect = await CursorAuthService.inspectSessionToken(context);
    return { ...base, sessionInspect };
}

function formatSessionInspectLines(inspect: SessionTokenInspectResult | null): string[] {
    if (!inspect) {
        return [];
    }
    switch (inspect.status) {
        case 'ok':
            return ['🟢 WorkosCursorSessionToken: 已成功读取', `   使用的 Cookie 库: ${inspect.cookiesDbPath}`];
        case 'missing':
            return [
                '⚠️ 已找到 Cookie 文件，但库中没有 WorkosCursorSessionToken',
                '   请在 Cursor 内打开 https://cursor.com 并登录账号后重试',
                `   检查的库: ${inspect.cookiesDbPath}`,
                '   提示: 真实 Session 可能在 Network/Cookies，扩展会依次尝试所有 Cookie 库',
            ];
        case 'encrypted':
            return [
                '⚠️ 找到 WorkosCursorSessionToken，但被系统加密，扩展无法解密',
                `   库: ${inspect.cookiesDbPath}`,
                '   请在设置 cursorPriceTracking.sessionToken 中手动粘贴浏览器 Cookie 值',
            ];
        case 'no_cookies_file':
            return ['未找到任何 Cookie 数据库文件'];
        default:
            return [];
    }
}

function formatScanStatusForSettings(
    context: vscode.ExtensionContext,
    result: CookieScanResult
): string {
    const autoRoot = CursorAuthService.getCursorUserDataPath(context);
    const lines: string[] = [];

    if (result.cookiesFilePath) {
        if (result.foundInManualFolder && result.manualFolder) {
            lines.push('🟢 已经在指定文件夹内找到 Cookie 文件');
            lines.push(`🟢 Cookie 文件路径: ${result.cookiesFilePath}`);
            lines.push('');
            lines.push(`指定的搜索文件夹: ${result.manualFolder}`);
        } else {
            lines.push('🟢 已找到 Cookie 文件');
            lines.push(`🟢 Cookie 文件路径: ${result.cookiesFilePath}`);
            if (result.manualFolder) {
                lines.push('');
                lines.push(`指定的搜索文件夹: ${result.manualFolder}`);
                lines.push('（在指定文件夹内尚未找到；上列为其他搜索路径中的结果）');
            }
        }
    } else {
        lines.push('未找到 Cookie 文件。请确认 Cursor 已登录，或检查下方搜索路径。');
        if (result.manualFolder) {
            lines.push('');
            lines.push(`指定的搜索文件夹: ${result.manualFolder}`);
        }
    }

    lines.push('');
    lines.push(...formatSessionInspectLines(result.sessionInspect));
    lines.push('');
    lines.push(`自动检测的 Cursor 用户数据目录: ${autoRoot}`);
    lines.push('');
    lines.push('本次扫描的文件夹:');
    for (const item of result.searchedRoots) {
        lines.push(`• ${item.path}`);
        lines.push(`  ${item.note}`);
    }

    return lines.join('\n');
}

export async function refreshCookiesScanStatus(context: vscode.ExtensionContext): Promise<CookieScanResult> {
    const result = await scanForCookiesFileAsync(context);
    const text = formatScanStatusForSettings(context, result);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(KEY_SCAN_STATUS, text, vscode.ConfigurationTarget.Global);
    return result;
}

export function registerCookiesScanStatusWatcher(
    context: vscode.ExtensionContext,
    onRefresh?: () => void
): void {
    const handler = async (event: vscode.ConfigurationChangeEvent) => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.${KEY_SEARCH_PATH}`)) {
            await refreshCookiesScanStatus(context);
            onRefresh?.();
        }
    };
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(handler));
}
