import { Parser } from './Parser'
import { Constants } from './Constants'
import { Strategy } from './Strategy'
import { conflictSectionsToTreeItem, ConflictTreeItem, ConflictTreeViewProvider, suggestionsToTreeItem } from './ConflictTreeView'
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { Conflict } from './Conflict'
import { ConflictLensProvider } from './ConflictLensProvider'
import { SoManyConflicts } from './SoManyConflicts'
import { ConflictSection } from './ConflictSection'
var Graph = require('@dagrejs/graphlib').Graph
const graphlib = require('@dagrejs/graphlib')
import { Queue } from 'queue-typescript'
import { MutexUtils } from './MutexUtils'

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "somanyconflicts" is now active!')

  let message: string = ''
  // raw conflict blocks
  let allConflictSections: ConflictSection[] = []
  // mutex lock
  const conflictSectionLock = new MutexUtils()
  // map from uri: ISection[]
  let conflictSectionsByFile = new Map<string, ConflictSection[]>()
  // TODO: make use of TextSection around ConflictSection for more information
  // let sectionsByFile = new Map<string, ISection[]>()
  // let conflictSectionsByFile: { [key: string]: ISection[] } = {}
  let graph: typeof Graph | undefined = undefined
  let conflictIconPath: string = context.asAbsolutePath('media/alert.png')
  let resolvedIconPath: string = context.asAbsolutePath('media/right.png')

  addSubcommandOpenFile(context)

  let [suggestedConflictTreeRoot, suggestedConflictTreeViewProvider] = createTree('suggestedConflictTreeView', conflictIconPath, resolvedIconPath)
  let [allConflictTreeRoot, allConflictTreeViewProvider] = createTree('allConflictTreeView', conflictIconPath, resolvedIconPath)

  const decorationType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    // borderWidth: '1px',
    // borderStyle: 'dashed',
    backgroundColor: { id: 'somanyconflicts.background_color' },
    gutterIconSize: 'contain',
    gutterIconPath: context.asAbsolutePath('media/right.png'),
    isWholeLine: true,
    // light: {
    //    borderColor: { id: 'somanyconflicts.border_color' },
    //   backgroundColor: 'lightgreen',
    //   // gutterIconPath: context.asAbsolutePath('media/hand-right-light.png'),
    // },
    // dark: {
    //   borderColor: 'yellow',
    //   backgroundColor: 'darkgreen',
    //   // gutterIconPath: context.asAbsolutePath('media/hand-right-dark.png'),
    // },
  })

  // check if the change edits a conflict section
  vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.contentChanges.length > 0) {
      // currently support well for code lens resolution, may contain bugs for manual edit
      let fsPath = event.document.uri.fsPath
      if (conflictSectionsByFile.has(fsPath)) {
        let conflictSections = conflictSectionsByFile.get(fsPath)
        if (conflictSections && conflictSections.length > 0) {
          // TODO: allow edit outside of conflicts
          for (let change of event.contentChanges) {
            let changeLines = Parser.getLines(change.text)
            for (let conflictSection of conflictSections) {
              let conflict = conflictSection.conflict
              if (change.range.contains(conflict.range)) {
                if (
                  change.text.includes(Constants.conflictMarkerOurs) &&
                  change.text.includes(Constants.conflictMarkerTheirs) &&
                  change.text.includes(Constants.conflictMarkerEnd)
                ) {
                  // undo operation detected
                  reversePropagateStrategy(conflictSection)
                  conflictSection.hasResolved = false
                  conflictSection.stragegy = Strategy.Unknown
                  conflictSection.resolvedCode = ''
                  await updateRanges(fsPath, conflictSections, change, changeLines.length)
                } else {
                  // resolved operation detected
                  // compare text line by line to update the strategy prob
                  conflictSection.checkStrategy(change.text)
                  console.log(
                    'Manually resolved: ' + conflictSection.conflict.uri?.fsPath + conflictSection.printLineRange() + ' via ' + conflictSection.stragegy.display
                  )
                  // TODO: only propagate to others if fully resolved
                  if (changeLines.length == 0) {
                    conflictSection.updateRangeWithoutComputing(
                      new vscode.Range(
                        new vscode.Position(conflictSection.conflict.range.start.line, 0),
                        new vscode.Position(conflictSection.conflict.range.start.line, 0)
                      )
                    )
                  } else {
                    conflictSection.updateRange(
                      new vscode.Range(
                        new vscode.Position(conflictSection.conflict.range.start.line, 0),
                        new vscode.Position(conflictSection.conflict.range.start.line + changeLines.length - 1, 0)
                      )
                    )
                  }
                  propagateStrategy(conflictSection)
                  await updateRanges(fsPath, conflictSections, change, changeLines.length)
                  return
                }
              }
            }
          }
        }
      }
    }
  })

  async function updateRanges(
    fsPath: string,
    oldConflictSections: ConflictSection[],
    change: vscode.TextDocumentContentChangeEvent,
    afterChangeLinesCnt: number
  ) {
    // let newSections: ConflictSection[] = SoManyConflicts.scanConflictsInFile(fsPath) // latent for auto-saving
    let newSections: ConflictSection[] = []

    if (vscode.window.activeTextEditor) {
      newSections = SoManyConflicts.scanConflictsInFile(fsPath, vscode.window.activeTextEditor.document.getText())
      // remove decoration after resolved
      vscode.window.activeTextEditor.setDecorations(decorationType, [])
    } else {
      newSections = SoManyConflicts.scanConflictsInFile(fsPath)
    }

    // if (newSections.length > 0) {
    let cnt: number = 0
    let changeLinesCnt: number = change.range.end.line - change.range.start.line - afterChangeLinesCnt
    for (let i = 0; i < oldConflictSections.length; ++i) {
      if (oldConflictSections[i].hasResolved) {
        cnt += 1
        let start = oldConflictSections[i].conflict.range.start.line,
          char_s = oldConflictSections[i].conflict.range.start.character
        let end = oldConflictSections[i].conflict.range.end.line,
          char_e = oldConflictSections[i].conflict.range.end.character
        if (change.range.end.line < start) {
          oldConflictSections[i].updateRange(
            new vscode.Range(new vscode.Position(start - changeLinesCnt, char_s), new vscode.Position(end - changeLinesCnt, char_e))
          )
        }
      } else {
        if (i - cnt >= 0 && i - cnt < newSections.length) {
          oldConflictSections[i].updateRange(newSections[i - cnt].conflict.range)
        }
      }
    }
    // }

    conflictSectionsToTreeItem(allConflictSections, allConflictTreeRoot).then((res) => {
      allConflictTreeViewProvider.refresh()
    })
    await vscode.commands.executeCommand('somanyconflicts.start')
  }

  // init: scan all conflicts in the current workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('somanyconflicts.scan', async () => {
      allConflictSections.length = 0
      conflictSectionsByFile = new Map<string, ConflictSection[]>()
      graph = undefined
      if (!isReady()) {
        await init()
      }
      if (allConflictSections.length == 0) {
        vscode.window.showWarningMessage('Found no merge conflicts in the current workspace!')
      } else {
        conflictSectionLock.dispatch(async () => {
          await conflictSectionsToTreeItem(allConflictSections, allConflictTreeRoot).then((res) => {
            allConflictTreeViewProvider.refresh()
            vscode.commands.executeCommand('allConflictTreeView.focus')
          })
        })
      }
    })
  )

  // feature1: topo-sort for the optimal order to resolve conflicts
  // TODO: call when activated
  context.subscriptions.push(
    vscode.commands.registerCommand('somanyconflicts.start', async () => {
      if (!isReady()) {
        await vscode.commands.executeCommand('somanyconflicts.scan')
      }
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Finding the starting point to resolve conflicts...',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            console.log('User canceled the scanning.')
          })

          let groupedConflictSections: ConflictSection[][] = SoManyConflicts.suggestStartingPoint(allConflictSections, graph)
          conflictSectionLock.dispatch(async () => {
            await suggestionsToTreeItem(groupedConflictSections, suggestedConflictTreeRoot).then((res) => {
              suggestedConflictTreeViewProvider.refresh()
              vscode.commands.executeCommand('suggestedConflictTreeView.focus')
            })
          })
          progress.report({ increment: 100 })
        }
      )
    })
  )

  let codeLensProviderDisposable = vscode.languages.registerCodeLensProvider('*', new ConflictLensProvider())
  // push the command and CodeLens provider to the context so it can be disposed of later
  context.subscriptions.push(codeLensProviderDisposable)

  // feature2: recommend the next (related or similar) conflict to resolve
  context.subscriptions.push(
    vscode.commands.registerCommand('somanyconflicts.next', async (...args: any[]) => {
      let conflictIndex: number = findSelectedConflictIndex(args)

      if (conflictIndex < 0) {
        vscode.window.showWarningMessage('Editor cursor is not within any merge conflict!')
        return
      }

      if (!isReady()) {
        await vscode.commands.executeCommand('somanyconflicts.scan')
      }
      // locate the focusing conflict and start from it
      SoManyConflicts.suggestRelatedConflicts(allConflictSections, conflictIndex, graph)
    })
  )

  // feature3: recommend resolution strategy given conflict resolved before
  // TODO: automatically call for related and jump?
  context.subscriptions.push(
    vscode.commands.registerCommand('somanyconflicts.how', async (...args: any[]) => {
      let conflictIndex: number = findSelectedConflictIndex(args)

      if (conflictIndex < 0) {
        vscode.window.showWarningMessage('Editor cursor is not within any merge conflict!')
        return
      }
      if (!isReady()) {
        await vscode.commands.executeCommand('somanyconflicts.scan')
      }
      // locate the focusing conflict and start from it
      // query previously resolved related conflicts
      // suggest resolution strategy accordingly
      SoManyConflicts.suggestResolutionStrategy(allConflictSections, conflictIndex, decorationType)
    })
  )

  // check if the workspace is readily prepared
  function isReady(): boolean {
    return allConflictSections.length != 0 && graph && graph !== undefined
  }

  async function scanConflictsInFolder(folder: vscode.WorkspaceFolder) {
    await conflictSectionLock.dispatch(async () => {
      if (allConflictSections.length == 0) {
        conflictSectionsByFile = await SoManyConflicts.scanAllConflicts(folder.uri.fsPath)

        for (let conflictSections of conflictSectionsByFile.values()) {
          for (let section of conflictSections) {
            section.index = allConflictSections.length.toString()
            allConflictSections.push(section)
          }
        }
      }
    })
  }

  async function init(): Promise<any> {
    const { workspaceFolders } = vscode.workspace
    if (!workspaceFolders) {
      message = 'Please open a workspace with merge conflicts first.'
      vscode.window.showWarningMessage(message)
      return
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Scanning so many conflicts in your workspace...',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          console.log('User canceled the scanning.')
        })

        // progress.report({ increment: 0 })

        // setTimeout(() => {
        //   progress.report({ increment: 10 })
        // }, 1000)

        await Promise.all(workspaceFolders.map(scanConflictsInFolder))

        if (allConflictSections.length == 0) {
          message = 'Found no merge conflicts in the current workspace!'
          vscode.window.showWarningMessage(message)
          return
        } else {
          // construct a graph to keep relations of conflicts
          graph = SoManyConflicts.constructGraph(allConflictSections)
          if (graph == undefined) {
            message = 'Failed to construct the graph for conflicts.'
            vscode.window.showErrorMessage(message)
            return
          }
        }
        message = 'Found ' + allConflictSections.length + ' conflicts in total in the current workspace.'
        vscode.window.showInformationMessage(message)
        progress.report({ increment: 100 })
      }
    )
  }

  function propagateStrategy(section: ConflictSection) {
    if (!graph || graph == undefined) {
      return
    }

    let strategiesProb: Array<number> = new Array<number>(6).fill(0)
    if (section.hasResolved) {
      strategiesProb[section.stragegy.index] = 1.0
    } else {
      strategiesProb = section.strategiesProb
    }
    // save index
    let visited = new Set<string>()
    let queue = new Queue<string>()
    queue.enqueue(section.index)
    visited.add(section.index)
    while (queue.length > 0) {
      let temp = queue.dequeue()
      if (temp) {
        visited.add(temp)
        let edges = graph.nodeEdges(temp)
        if (edges && edges.length > 0) {
          for (let e of edges) {
            if (!visited.has(e.v)) {
              let conflictSection = allConflictSections[e.v]
              let newProbs = conflictSection.updateStrategy(strategiesProb, graph.edge(e))
              queue.enqueue(e.v)
            }
            if (!visited.has(e.w)) {
              let conflictSection = allConflictSections[e.w]
              let newProbs = conflictSection.updateStrategy(strategiesProb, graph.edge(e))
              queue.enqueue(e.w)
            }
          }
        }
      }
    }
    // TODO: consider def-use direction, find and update connected nodes with DFS/BFS
  }

  function reversePropagateStrategy(section: ConflictSection) {
    if (!graph || graph == undefined) {
      return
    }

    let strategiesProb: Array<number> = new Array<number>(6).fill(0)
    if (section.hasResolved) {
      strategiesProb[section.stragegy.index] = 1.0
    } else {
      strategiesProb = section.strategiesProb
    }
    // save index
    let visited = new Set<string>()
    let queue = new Queue<string>()
    queue.enqueue(section.index)
    visited.add(section.index)
    while (queue.length > 0) {
      let temp = queue.dequeue()
      if (temp) {
        visited.add(temp)
        let edges = graph.nodeEdges(temp)
        if (edges && edges.length > 0) {
          for (let e of edges) {
            if (!visited.has(e.v)) {
              let conflictSection = allConflictSections[e.v]
              let newProbs = conflictSection.reverseUpdatedStrategy(strategiesProb, graph.edge(e))
              queue.enqueue(e.v)
            }
            if (!visited.has(e.w)) {
              let conflictSection = allConflictSections[e.w]
              let newProbs = conflictSection.reverseUpdatedStrategy(strategiesProb, graph.edge(e))
              queue.enqueue(e.w)
            }
          }
        }
      }
    }
  }

  function findSelectedConflictIndex(args: any[]): number {
    if (args[0] === 'current-conflict') {
      let invokedConflict: Conflict = args[1]
      // match the conflict and get its index
      for (let i in allConflictSections) {
        let conflict = allConflictSections[i].conflict
        if (conflict.uri?.path == invokedConflict.uri?.path && conflict.range.isEqual(invokedConflict.range)) {
          // currently use array index as index, but can be extended (like fileIndex:conflictIndex)
          return +allConflictSections[i].index
        }
      }
    } else {
      // attempt to find a conflict that matches the current cursor position
      if (vscode.window.activeTextEditor) {
        for (let i in allConflictSections) {
          let conflict = allConflictSections[i].conflict
          if (conflict.range.contains(vscode.window.activeTextEditor.selection.active)) {
            return +i
          }
        }
      }
    }
    return -1
  }
}
// this method is called when your extension is deactivated
export function deactivate() {}

function addSubcommandOpenFile(context: vscode.ExtensionContext) {
  const commandsToOpenFiles = 'somanyconflicts.openFileAt'
  const openFileHandler = async function (uri: vscode.Uri, range: vscode.Range) {
    await vscode.commands.executeCommand('vscode.open', uri).then((x) => {
      let activeEditor = vscode.window.activeTextEditor
      if (activeEditor) {
        activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter)
        activeEditor.selection = new vscode.Selection(range.start, range.start)
      }
    })
  }
  context.subscriptions.push(vscode.commands.registerCommand(commandsToOpenFiles, openFileHandler))
}

function createTree(viewName: string, resolvedIconPath: string, conflictIconPath: string): [ConflictTreeItem[], ConflictTreeViewProvider] {
  let treeRoot: ConflictTreeItem[] = []
  const treeViewProvider = new ConflictTreeViewProvider(treeRoot, resolvedIconPath, conflictIconPath)
  vscode.window.registerTreeDataProvider(viewName, treeViewProvider)
  return [treeRoot, treeViewProvider]
}
