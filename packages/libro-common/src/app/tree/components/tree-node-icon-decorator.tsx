import { ViewInstance } from '../../../core/index.js';
import { useInject } from '../../../observable/index.js';
import * as React from 'react';

import { notEmpty } from '../../../common/index.js';
import type { TreeNodeIconDecoratorProps } from '../tree.js';
import type { TreeViewDecoration } from '../tree-view-decoration.js';
import {
  IconOverlayPosition,
  TreeViewDecorationStyles,
} from '../tree-view-decoration.js';
import type { TreeView } from '../view/tree-view.js';
import { TreeViewDecorator } from '../view/tree-view-decorator.js';

export const TreeNodeIconDecorator: React.FC<TreeNodeIconDecoratorProps> = (
  props: TreeNodeIconDecoratorProps,
) => {
  const treeViewDecorator = useInject<TreeViewDecorator>(TreeViewDecorator);
  const treeView = useInject<TreeView>(ViewInstance);
  const { icon, node } = props;
  if (icon === null) {
    return null;
  }

  const overlayIcons: React.ReactNode[] = [];
  new Map(
    treeViewDecorator
      .getDecorationData(node, 'iconOverlay')
      .reverse()
      .filter(notEmpty)
      .map(
        (overlay) =>
          [overlay.position, overlay] as [
            IconOverlayPosition,
            TreeViewDecoration.IconOverlay | TreeViewDecoration.IconClassOverlay,
          ],
      ),
  ).forEach((overlay, position) => {
    const iconClasses = [
      TreeViewDecorationStyles.DECORATOR_SIZE_CLASS,
      IconOverlayPosition.getStyle(position),
    ];
    const style = (color?: string) => (color === undefined ? {} : { color });
    if (overlay.background) {
      overlayIcons.push(
        <span
          key={`${node.id}bg`}
          className={treeView.getIconClass(overlay.background.shape, iconClasses)}
          style={style(overlay.background.color)}
        ></span>,
      );
    }
    const overlayIcon =
      (overlay as TreeViewDecoration.IconOverlay).icon ||
      (overlay as TreeViewDecoration.IconClassOverlay).iconClass;
    overlayIcons.push(
      <span
        key={node.id}
        className={treeView.getIconClass(overlayIcon, iconClasses)}
        style={style(overlay.color)}
      ></span>,
    );
  });

  if (overlayIcons.length > 0) {
    return (
      <div className={TreeViewDecorationStyles.ICON_WRAPPER_CLASS}>
        {icon}
        {overlayIcons}
      </div>
    );
  }

  return icon as React.ReactElement;
};
