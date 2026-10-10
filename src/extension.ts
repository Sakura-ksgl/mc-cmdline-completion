import * as vscode from 'vscode';
import { AdapterRegistry } from './adapter/registry';
import { CAdapter } from './adapter/c/cAdapter';
import { CppAdapter } from './adapter/cpp/cppAdapter';
import { PythonAdapter } from './adapter/python/pythonAdapter';
import { CommandLineCompletionProvider } from './completion/provider';
import { sliceSegment } from './completion/segment';
import { registerInteractionKeys } from './interaction/keymap';

export function activate(context: vscode.ExtensionContext): void {
  const registry = new AdapterRegistry();

  // ────────────────────────────────────────────────────────────────
  // 阶段 4 / 5：装配真实语言适配器。
  //
  // 阶段 6 在这里追加（通用层不需要任何改动）：
  //   registry.register(new CppAdapter());
  //
  // 注意：stubAdapter 不再注册 —— 它的 languageIds 是 ['*']，
  // 一旦注册就会在任何语言的文件里弹占位候选，让「没有适配器的语言不弹候选」失效。
  // 文件保留是为了让 scripts/verify.mjs 继续验证通用层逻辑。
  // ────────────────────────────────────────────────────────────────
  registry.register(new PythonAdapter());
  registry.register(new CAdapter());
  registry.register(new CppAdapter());

  // 诊断日志：开发模式（F5）下自动打开，正式使用时不打（也可用 mcSuggest.debugLog 强制打开）
  const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
  const provider = new CommandLineCompletionProvider(registry, isDevelopment);

  // 一个适配器一次注册：selector 与触发字符严格配对。
  // 不能把所有适配器的 languageId、delimiters 各合成一份 ——
  // 那会让某个语言的触发字符串到别的语言的文件里，也会让 '*' 兜底全局生效。
  for (const registration of registry.registrations()) {
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        registration.selectors,
        provider,
        ...registration.triggerCharacters,
      ),
    );
  }
  context.subscriptions.push(...registerInteractionKeys());

  const output = vscode.window.createOutputChannel('MC Cmdline');
  context.subscriptions.push(output);

  context.subscriptions.push(
    // 自查：当前文件的适配器情况
    vscode.commands.registerCommand('mcSuggest.showStatus', async () => {
      const languageId = vscode.window.activeTextEditor?.document.languageId ?? '(没有打开文件)';
      const names = registry.list().map((adapter) => adapter.name).join(', ');
      await vscode.window.showInformationMessage(
        `MC 补全：当前文件语言 = ${languageId}；已注册适配器 = [${names}]`,
      );
    }),

    // 自查：把光标处的切段结果原样打出来
    vscode.commands.registerCommand('mcSuggest.inspectSegment', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('MC 补全：当前没有打开的文件。');
        return;
      }

      const document = editor.document;
      const position = editor.selection.active;
      const adapter = registry.resolve(document);
      if (!adapter) {
        void vscode.window.showWarningMessage(
          `MC 补全：没有适配器处理 ${document.languageId}（这个语言不会弹候选）。`,
        );
        return;
      }

      const slice = sliceSegment(
        document.lineAt(position.line).text,
        position.character,
        adapter.getSegmentStrategy(),
      );

      output.clear();
      output.appendLine('=== MC 补全：切段结果 ===');
      output.appendLine(`文件语言   : ${document.languageId}`);
      output.appendLine(`适配器     : ${adapter.name}`);
      output.appendLine(
        `光标       : 第 ${position.line + 1} 行，第 ${position.character + 1} 列（1-based）`,
      );
      output.appendLine(`当前段文本 : "${slice.text}"`);
      output.appendLine(`当前段范围 : [${slice.start}, ${slice.end}) 行内 0-based offset`);
      output.appendLine(`触发分隔符 : ${slice.delimiter ?? '(无)'}`);
      output.appendLine(`括号深度   : ${slice.depth}`);
      output.appendLine(`第几个参数 : ${slice.argumentIndex ?? '(不在括号内)'}`);
      output.appendLine(`之前各段   : ${slice.before.length > 0 ? slice.before.join(' | ') : '(空)'}`);
      // 保留编辑器焦点，别让输出面板抢走光标
      output.show(true);
    }),
  );

  console.log(
    '[mc-cmdline-completion] 已激活，适配器 =',
    registry.list().map((adapter) => adapter.name),
    '装配 =',
    registry
      .registrations()
      .map((r) => `${JSON.stringify(r.selectors)} 触发[${r.triggerCharacters.join('')}]`),
  );
}

export function deactivate(): void {
  // 所有资源都挂在 context.subscriptions 上，无需手动清理。
}
