import * as vscode from 'vscode';

/**
 * 交互命令 id。
 *
 * Tab / Shift+Tab 的「抢绑」写在 package.json 的 `contributes.keybindings` 里，
 * 绑的是这里的命令，而不是直接绑 VSCode 内置命令 —— 这样做有三个好处：
 *  1. 移动前后可以插入我们自己的逻辑（阶段 2 起需要，比如联动分段状态）；
 *  2. 用户能在快捷键面板里看到、改绑或禁用；
 *  3. 候选列表意外不可见时不会抛错打断输入。
 */
export const CMD_SELECT_NEXT = 'mcSuggest.selectNext';
export const CMD_SELECT_PREV = 'mcSuggest.selectPrev';
export const CMD_TRIGGER = 'mcSuggest.trigger';

async function forward(commandId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(commandId);
  } catch {
    // 没有可聚焦的编辑器、或 suggest 列表已经关闭：静默忽略。
  }
}

export function registerInteractionKeys(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD_SELECT_NEXT, () => forward('selectNextSuggestion')),
    vscode.commands.registerCommand(CMD_SELECT_PREV, () => forward('selectPrevSuggestion')),
    vscode.commands.registerCommand(CMD_TRIGGER, () => forward('editor.action.triggerSuggest')),
  ];
}
