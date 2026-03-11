import { execFile } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as http from 'http';

const execFileAsync = promisify(execFile);

export interface LSInfo {
    pid: number;
    csrfToken: string;
    port: number;
    useTls: boolean;
}

// ─── CR2-Fix4: Exported Parsing Functions ────────────────────────────────────
// Extracted from discoverLanguageServer() so tests can validate production code
// directly, instead of re-implementing the same regex logic in test files.

/**
 * Build the expected workspace_id from a workspace URI.
 * Mirrors the conversion Antigravity uses for --workspace_id process argument.
 */
export function buildExpectedWorkspaceId(workspaceUri: string): string {
    return workspaceUri.replace(':///', '_').replace(/\//g, '_');
}

/**
 * Extract PID from a ps output line.
 */
export function extractPid(line: string): number | null {
    const pidMatch = line.trim().match(/^\s*(\d+)\s/);
    return pidMatch ? parseInt(pidMatch[1], 10) : null;
}

/**
 * Extract CSRF token from a ps output line.
 */
export function extractCsrfToken(line: string): string | null {
    const csrfMatch = line.match(/--csrf_token\s+([^\s]+)/);
    return csrfMatch ? csrfMatch[1] : null;
}

/**
 * Extract workspace_id from a ps output line.
 */
export function extractWorkspaceId(line: string): string | null {
    const match = line.match(/--workspace_id\s+([^\s]+)/);
    return match ? match[1] : null;
}

/**
 * Filter ps output lines for LS processes.
 */
export function filterLsProcessLines(psOutput: string): string[] {
    return psOutput.split('\n').filter(l =>
        l.includes('language_server_macos') && l.includes('antigravity')
    );
}

/**
 * Extract port from a lsof output line.
 */
export function extractPort(line: string): number | null {
    const portMatch = line.match(/127\.0\.0\.1:(\d+)\s/);
    return portMatch ? parseInt(portMatch[1], 10) : null;
}

/**
 * Discover the Antigravity language server process that belongs to this workspace.
 * Extracts PID, CSRF token from process args, and finds the listening port.
 *
 * S2 fix: Uses async execFile instead of execSync to avoid blocking the VS Code UI thread.
 * S3 fix: Uses execFile (no shell) to prevent command injection risks.
 * CR-#3: Accepts AbortSignal for cancellation on extension deactivate.
 */
export async function discoverLanguageServer(workspaceUri?: string, signal?: AbortSignal): Promise<LSInfo | null> {
    if (process.platform === 'win32') {
        return discoverLanguageServerWindows(workspaceUri, signal);
    }
    return discoverLanguageServerMacOS(workspaceUri, signal);
}

// ─── Windows Discovery ───────────────────────────────────────────────────────

/**
 * Filter wmic output blocks for LS processes.
 * @deprecated Kept for backward compatibility on older Windows versions.
 */
export function filterWmicProcessBlocks(wmicOutput: string): Array<{ cmd: string; pid: string }> {
    const results: Array<{ cmd: string; pid: string }> = [];
    let current: { cmd?: string; pid?: string } = {};
    for (const line of wmicOutput.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CommandLine=')) {
            current.cmd = trimmed.substring(12);
        } else if (trimmed.startsWith('ProcessId=')) {
            current.pid = trimmed.substring(10);
            if (current.cmd) {
                results.push({ cmd: current.cmd, pid: current.pid });
            }
            current = {};
        }
    }
    return results.filter(p =>
        p.cmd.toLowerCase().includes('language_server') &&
        p.cmd.toLowerCase().includes('antigravity') &&
        !p.cmd.toLowerCase().includes('wmic')
    );
}

/**
 * Parse PowerShell JSON output from Get-CimInstance into process entries.
 * Handles both single-object and array JSON output.
 */
export function parsePowerShellProcesses(jsonOutput: string): Array<{ cmd: string; pid: string }> {
    try {
        const trimmed = jsonOutput.trim();
        if (!trimmed) { return []; }
        const parsed = JSON.parse(trimmed);
        const items: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : [parsed];
        return items
            .filter(item => {
                const cmd = String(item.CommandLine || '').toLowerCase();
                return cmd.includes('language_server') && cmd.includes('antigravity');
            })
            .map(item => ({
                cmd: String(item.CommandLine || ''),
                pid: String(item.ProcessId || ''),
            }));
    } catch {
        return [];
    }
}

/**
 * Extract listening port from netstat output for a given PID.
 */
export function extractPortFromNetstat(netstatOutput: string, pid: string): number | null {
    for (const line of netstatOutput.split('\n')) {
        if (line.includes('LISTENING') && line.trim().endsWith(pid)) {
            const m = line.match(/127\.0\.0\.1:(\d+)/);
            if (m) { return parseInt(m[1], 10); }
        }
    }
    return null;
}

/**
 * Find LS processes on Windows.
 * Primary: PowerShell Get-CimInstance with WQL filter (works on all modern Windows).
 * Fallback: wmic (deprecated, removed in Windows 11 23H2+) — only attempted if wmic exists.
 */
async function findWindowsLsProcesses(signal?: AbortSignal): Promise<Array<{ cmd: string; pid: string }>> {
    // Primary: PowerShell Get-CimInstance with server-side WQL filter → JSON
    try {
        const psScript =
            "Get-CimInstance Win32_Process " +
            "-Filter \"CommandLine LIKE '%language_server%' AND CommandLine LIKE '%antigravity%'\" " +
            "| Select-Object ProcessId, CommandLine " +
            "| ConvertTo-Json -Compress";
        const result = await execFileAsync('powershell.exe', [
            '-NoProfile', '-NoLogo', '-Command', psScript
        ], { encoding: 'utf-8', timeout: 15000, signal });
        // PowerShell succeeded — trust the result even if empty (LS not running)
        return parsePowerShellProcesses(result.stdout);
    } catch {
        // PowerShell itself failed (e.g. not on PATH, execution policy) — try wmic
    }

    // Fallback: wmic (for older Windows that still has it)
    // Check if wmic exists first to avoid a slow timeout on Windows 11 23H2+
    try {
        await execFileAsync('where.exe', ['wmic'], { encoding: 'utf-8', timeout: 3000 });
    } catch {
        // wmic not found — nothing more we can do
        return [];
    }

    try {
        const result = await execFileAsync('wmic', [
            'process', 'where',
            "commandline like '%language_server%'",
            'get', 'ProcessId,CommandLine',
            '/format:list'
        ], { encoding: 'utf-8', timeout: 10000, signal });
        return filterWmicProcessBlocks(result.stdout);
    } catch {
        return [];
    }
}

/**
 * Windows LS discovery using PowerShell/wmic + netstat.
 */
async function discoverLanguageServerWindows(workspaceUri?: string, signal?: AbortSignal): Promise<LSInfo | null> {
    try {
        // 1. Find LS processes
        const processes = await findWindowsLsProcesses(signal);
        if (processes.length === 0) { return null; }

        // Match workspace if provided
        let target = processes[0];
        if (workspaceUri) {
            const expectedWsId = buildExpectedWorkspaceId(workspaceUri);
            const matched = processes.find(p => {
                const wsId = extractWorkspaceId(p.cmd);
                return wsId === expectedWsId;
            });
            if (matched) { target = matched; }
        }

        const pid = parseInt(target.pid, 10);
        if (isNaN(pid)) { return null; }

        const csrfToken = extractCsrfToken(target.cmd);
        if (!csrfToken) { return null; }

        // 2. Find listening port via netstat
        let netstatOutput: string;
        try {
            const result = await execFileAsync('netstat', ['-ano'], {
                encoding: 'utf-8', timeout: 10000, signal
            });
            netstatOutput = result.stdout;
        } catch {
            return null;
        }

        // Collect all ports for this PID
        const ports: number[] = [];
        for (const line of netstatOutput.split('\n')) {
            if (line.includes('LISTENING') && line.trim().endsWith(String(pid))) {
                const m = line.match(/127\.0\.0\.1:(\d+)/);
                if (m) { ports.push(parseInt(m[1], 10)); }
            }
        }
        if (ports.length === 0) { return null; }

        // 3. Probe ports
        for (const port of ports) {
            const httpsResult = await probePort(port, csrfToken, true, signal);
            if (httpsResult) {
                return { pid, csrfToken, port, useTls: true };
            }
            const httpResult = await probePort(port, csrfToken, false, signal);
            if (httpResult) {
                return { pid, csrfToken, port, useTls: false };
            }
        }

        // Fallback: return first port without probe
        return { pid, csrfToken, port: ports[0], useTls: true };
    } catch {
        return null;
    }
}

// ─── macOS Discovery ─────────────────────────────────────────────────────────

async function discoverLanguageServerMacOS(workspaceUri?: string, signal?: AbortSignal): Promise<LSInfo | null> {
    try {
        let psOutput: string;
        try {
            const result = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
                encoding: 'utf-8',
                timeout: 5000,
                signal
            });
            psOutput = result.stdout;
        } catch {
            return null;
        }

        const lines = filterLsProcessLines(psOutput);
        if (lines.length === 0) { return null; }

        let targetLine = lines[0];
        if (workspaceUri) {
            const expectedWorkspaceId = buildExpectedWorkspaceId(workspaceUri);
            const matchedLine = lines.find(line => {
                const wsId = extractWorkspaceId(line);
                return wsId === expectedWorkspaceId;
            });
            if (matchedLine) { targetLine = matchedLine; }
        }

        const firstLine = targetLine.trim();
        const pid = extractPid(firstLine);
        if (!pid) { return null; }

        const csrfToken = extractCsrfToken(firstLine);
        if (!csrfToken) { return null; }

        let lsofOutput: string;
        try {
            const result = await execFileAsync('lsof', [
                '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)
            ], { encoding: 'utf-8', timeout: 5000, signal });
            lsofOutput = result.stdout.trim();
        } catch {
            return null;
        }

        if (!lsofOutput) { return null; }

        const ports: number[] = [];
        for (const line of lsofOutput.split('\n')) {
            const port = extractPort(line);
            if (port !== null) { ports.push(port); }
        }
        if (ports.length === 0) { return null; }

        for (const port of ports) {
            const httpsResult = await probePort(port, csrfToken, true, signal);
            if (httpsResult) {
                return { pid, csrfToken, port, useTls: true };
            }
            const httpResult = await probePort(port, csrfToken, false, signal);
            if (httpResult) {
                return { pid, csrfToken, port, useTls: false };
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Probe a port by sending a lightweight RPC request.
 * M3 fix: Now checks HTTP status code — rejects non-2xx responses.
 */
async function probePort(port: number, csrfToken: string, useTls: boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        // CR-C2: Early abort check
        if (signal?.aborted) {
            resolve(false);
            return;
        }

        let settled = false;
        const settle = (value: boolean) => {
            if (settled) { return; }
            settled = true;
            cleanupAbortListener();
            resolve(value);
        };

        const postData = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                ideVersion: 'unknown',
                locale: 'en'
            }
        });

        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            // Use GetUnleashData for lightweight port probing (per openusage docs)
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrfToken,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 3000,
            rejectUnauthorized: false // Self-signed cert
        };

        // CR-C2: Abort listener — destroy request on signal abort
        let onAbort: (() => void) | undefined;
        const cleanupAbortListener = () => {
            if (onAbort && signal) {
                signal.removeEventListener('abort', onAbort);
                onAbort = undefined;
            }
        };

        const transport = useTls ? https : http;
        // CR-M1: probePort body limit — only need to validate JSON, cap at 1MB
        const PROBE_MAX_BODY = 1024 * 1024;
        const req = transport.request(options, (res) => {
            let body = '';
            let bodySize = 0;
            res.on('data', (chunk: Buffer | string) => {
                bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                if (bodySize > PROBE_MAX_BODY) {
                    req.destroy();
                    settle(false);
                    return;
                }
                body += chunk;
            });
            // CR2-Fix3: Handle response-side stream errors (e.g. TCP RST,
            // half-broken connections). Without this, the Promise would hang
            // until the req.on('timeout') fires.
            res.on('error', () => settle(false));
            res.on('end', () => {
                // M3: Check HTTP status code — 4xx/5xx are not valid RPC endpoints
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    settle(false);
                    return;
                }
                try {
                    JSON.parse(body);
                    // Any valid JSON response with 2xx status indicates a working RPC endpoint
                    settle(true);
                } catch {
                    settle(false);
                }
            });
        });

        req.on('error', () => settle(false));
        req.on('timeout', () => { req.destroy(); settle(false); });

        if (signal) {
            onAbort = () => { req.destroy(); settle(false); };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        req.write(postData);
        req.end();
    });
}
