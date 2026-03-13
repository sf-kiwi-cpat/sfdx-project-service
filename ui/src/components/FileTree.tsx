import { useState } from 'react';
import type { TreeNode } from '../types';
import './FileTree.css';

interface Props {
  node: TreeNode;
  depth?: number;
}

export default function FileTree({ node, depth = 0 }: Props) {
  const [expanded, setExpanded] = useState(depth < 2); // auto-expand first 2 levels
  const isDir = node.type === 'directory';

  return (
    <div className="filetree-node" style={{ paddingLeft: depth * 16 }}>
      <button
        className={`filetree-label ${isDir ? 'filetree-label--dir' : 'filetree-label--file'}`}
        onClick={() => {
          if (isDir) setExpanded(!expanded);
        }}
        tabIndex={0}
      >
        {isDir ? (
          <span className={`filetree-arrow ${expanded ? 'filetree-arrow--open' : ''}`}>
            &#9654;
          </span>
        ) : (
          <span className="filetree-dot" />
        )}
        <span className="filetree-name">{node.name}</span>
      </button>

      {isDir && expanded && node.children && (
        <div className="filetree-children">
          {node.children.map((child) => (
            <FileTree key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
