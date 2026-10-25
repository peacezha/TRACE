import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

describe('desktop request-header authentication', () => {
  it('injects the main-process token through webRequest before loading the page', () => {
    expect(mainSource).toContain('win.webContents.session.webRequest.onBeforeSendHeaders');
    expect(mainSource).toContain("details.requestHeaders['X-TRACE-Desktop-Token'] = desktopToken");
    expect(mainSource).toContain('mainWindow = createWindow(url, desktopToken)');
    expect(mainSource.indexOf('onBeforeSendHeaders')).toBeLessThan(mainSource.indexOf('win.loadURL(url)'));
  });

  it('filters both the Electron URL pattern and the parsed request origin', () => {
    expect(mainSource).toContain('const trustedOrigin = new URL(url).origin');
    expect(mainSource).toContain('urls: [`${trustedOrigin}/*`]');
    expect(mainSource).toContain('requestOrigin = new URL(details.url).origin');
    expect(mainSource).toContain('if (requestOrigin === trustedOrigin)');
  });
});
