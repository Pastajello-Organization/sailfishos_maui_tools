import * as vscode from 'vscode';

export type BuildConfiguration = 'Debug' | 'Release';
const KEY = 'mauiSailfish.configuration';

/**
 * The Debug | Release switch in the status bar, like Visual Studio's configuration dropdown: F5 and Ctrl+F5 build
 * what it shows unless the launch configuration names one. Remembered per workspace.
 */
export class ConfigurationSwitch implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('mauiSailfish.configuration', vscode.StatusBarAlignment.Left, 49);

  constructor(private readonly state: vscode.Memento) {
    this.item.name = 'MAUI Sailfish Build Configuration';
    this.item.command = 'mauiSailfish.selectConfiguration';
    this.render();
  }

  get current(): BuildConfiguration {
    return this.state.get<BuildConfiguration>(KEY, 'Debug');
  }

  show(): void {
    this.item.show();
  }

  async select(): Promise<void> {
    const items: (vscode.QuickPickItem & { value: BuildConfiguration })[] = [
      { value: 'Debug', label: 'Debug', description: 'untrimmed, full debugging; installs as <package>-debug' },
      { value: 'Release', label: 'Release', description: 'trimmed + ReadyToRun, the build you ship; installs as <package>' },
    ];
    for (const item of items) {
      if (item.value === this.current) item.label = `$(check) ${item.label}`;
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'MAUI Sailfish: build configuration for F5 / Ctrl+F5' });
    if (picked) {
      await this.state.update(KEY, picked.value);
      this.render();
    }
  }

  private render(): void {
    this.item.text = `$(gear) ${this.current}`;
    this.item.tooltip = `MAUI Sailfish builds ${this.current} on F5 / Ctrl+F5 (a launch configuration's "configuration" wins). Click to switch.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
