import { ConflictSection } from './ConflictSection'
import { ISection } from './ISection'
import * as vscode from 'vscode'

export class ConflictTreeViewProvider implements vscode.TreeDataProvider<ConflictTreeItem> {
  constructor(private conflict: ConflictTreeItem[], private conflictIconPath: string, private resolvedIconPath: string) {
    // console.log("conflict", conflict)
  }
  getTreeItem(item: ConflictTreeItem): vscode.TreeItem {
    if (item.uri && item.range && item.label) {
      return {
        // resourceUri: item.uri,
        label: item.label,
        command: {
          command: 'somanyconflicts.openFileAt',
          title: 'Open',
          arguments: [item.uri, item.range],
        },
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: item.state == -1 ? this.conflictIconPath : this.resolvedIconPath,
      }
    } else if (item.uri) {
      return {
        resourceUri: item.uri,
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        iconPath: vscode.ThemeIcon.File
      }
    } else if (item.label) {
      return new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded)
    } else {
      throw 'data error'
    }
  }
  getChildren(element?: ConflictTreeItem): Thenable<ConflictTreeItem[]> {
    if (element) {
      return Promise.resolve(element.children)
    } else {
      return Promise.resolve(this.conflict)
    }
  }

  private _onDidChangeTreeData: vscode.EventEmitter<ConflictTreeItem | undefined | null | void> = new vscode.EventEmitter<
    ConflictTreeItem | undefined | null | void
  >()

  readonly onDidChangeTreeData: vscode.Event<ConflictTreeItem | undefined | null | void> = this._onDidChangeTreeData.event

  refresh(data: ConflictTreeItem | undefined | null | void): void {
    this._onDidChangeTreeData.fire()
  }
}

enum ConflictTreeItemState {
  conflicting = -1,
  resolved = 1,
  default = 0,
}

export class ConflictTreeItem {
  constructor(
    public label: string | undefined,
    public uri: vscode.Uri | undefined,
    public range: vscode.Range | undefined,
    public children: Array<ConflictTreeItem>,
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public state: ConflictTreeItemState
  ) {}
}

export async function conflictSectionsToTreeItem(allConflictSections: ConflictSection[], parents: ConflictTreeItem[]) {
  parents.length = 0
  for (let conflictSection of allConflictSections) {
    let doc = await vscode.workspace.openTextDocument(conflictSection.conflict.uri!)
    let conflict = conflictSection.conflict
    let start = new vscode.Position(conflict.range.start.line + 1, conflict.range.start.character)
    if(conflictSection.hasResolved){
      start = new vscode.Position(conflict.range.start.line, conflict.range.start.character)
    }
    let range = new vscode.Range(start, conflict.range.end)
    let label = conflictSection.printLineRange() + ' ' + doc.getText(range).trimLeft()
    let newConflict = new ConflictTreeItem(label, conflict.uri, conflict.range, [], vscode.TreeItemCollapsibleState.None, conflictSection.hasResolved ? ConflictTreeItemState.resolved : ConflictTreeItemState.conflicting)
    let flag = false
    for (let parent of parents) {
      if (newConflict.uri == parent.uri) {
        parent.children.push(newConflict)
        flag = true
        break
      }
    }
    if (!flag) {
      let newParent = new ConflictTreeItem(undefined, conflict.uri, undefined, [newConflict], vscode.TreeItemCollapsibleState.Expanded, ConflictTreeItemState.default)
      parents.push(newParent)
    }
  }
  return parents
}

export async function suggestionsToTreeItem(suggestions: ConflictSection[][], parents: ConflictTreeItem[]) {
  let idx = 0
  parents.length = 0
  for (let group of suggestions) {
    idx++
    let groupRoot = new ConflictTreeItem('Group' + idx, undefined, undefined, [], vscode.TreeItemCollapsibleState.Expanded, 0)
    for (let conflictSection of group) {
      let doc = await vscode.workspace.openTextDocument(conflictSection.conflict.uri!)
      let conflict = conflictSection.conflict
      let start = new vscode.Position(conflict.range.start.line + 1, conflict.range.start.character)
      if(conflictSection.hasResolved){
        start = new vscode.Position(conflict.range.start.line, conflict.range.start.character)
      }
      let range = new vscode.Range(start, conflict.range.end)
      let label = conflictSection.printLineRange() + ' ' + doc.getText(range).trimLeft()
      let newConflict = new ConflictTreeItem(
        label,
        conflict.uri,
        conflict.range,
        [],
        vscode.TreeItemCollapsibleState.None,
        conflictSection.hasResolved ? 1 : -1
      )
      groupRoot.children.push(newConflict)
    }
    parents.push(groupRoot)
  }
  return parents
}
