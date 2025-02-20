import debounce from 'lodash.debounce';

import type { Disposable } from '../../../common/index.js';
import { DisposableCollection } from '../../../common/index.js';
import { notEmpty } from '../../../common/index.js';
import { ViewOption } from '../../../core/index.js';
import { inject, postConstruct, singleton } from '../../../ioc/index.js';
import { prop } from '../../../observable/index.js';
import { DecoratedTreeNode, TreeDecoratorService } from '../tree-decorator.js';
import { TreeModel } from '../tree-model.js';
import type { TreeProps } from '../tree-protocol.js';
import { TreeViewDecorationData } from '../tree-view-decoration.js';
import type { TreeNode } from '../tree.js';

@singleton()
export class TreeViewDecorator implements Disposable {
  @prop()
  decorations: Map<string, TreeViewDecorationData[]> = new Map();
  protected toDispose = new DisposableCollection();

  protected readonly decoratorService: TreeDecoratorService;
  readonly model: TreeModel;
  protected readonly props: TreeProps;

  constructor(
    @inject(TreeDecoratorService) decoratorService: TreeDecoratorService,
    @inject(TreeModel) model: TreeModel,
    @inject(ViewOption) props: TreeProps,
  ) {
    this.decoratorService = decoratorService;
    this.model = model;
    this.props = props;
  }

  @postConstruct()
  protected init(): void {
    this.toDispose.push(
      this.model.onNodeRefreshed(() => this.updateDecorations()),
      this.model.onExpansionChanged(() => this.updateDecorations()),
    );
  }

  dispose() {
    this.toDispose.dispose();
  }

  /**
   * Update tree decorations.
   * - Updating decorations are debounced in order to limit the number of expensive updates.
   */
  readonly updateDecorations: () => Promise<void> | undefined = debounce(
    () => this.doUpdateDecorations(),
    150,
  );
  protected async doUpdateDecorations(): Promise<void> {
    this.decorations = await this.decoratorService.getDecorations(this.model);
    // this.forceUpdate();
  }

  /**
   * Get the tree decoration data for the given key.
   * @param node the tree node.
   * @param key the tree decoration data key.
   *
   * @returns the tree decoration data at the given key.
   */
  getDecorationData<K extends keyof TreeViewDecorationData>(
    node: TreeNode,
    key: K,
  ): TreeViewDecorationData[K][] {
    return this.getDecorations(node)
      .filter((data) => data[key] !== undefined)
      .map((data) => data[key])
      .filter(notEmpty);
  }
  /**
   * Get the tree node decorations.
   * @param node the tree node.
   * @returns the list of tree decoration data.
   */
  protected getDecorations(node: TreeNode): TreeViewDecorationData[] {
    const decorations: TreeViewDecorationData[] = [];
    if (DecoratedTreeNode.is(node)) {
      decorations.push(node.decorationData);
    }
    if (this.decorations.has(node.id)) {
      decorations.push(...this.decorations.get(node.id)!);
    }
    return decorations.sort(TreeViewDecorationData.comparePriority);
  }
}
