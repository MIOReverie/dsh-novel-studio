'use strict';

/**
 * 墨枢自带图标集：24×24 线性图标，全部自绘路径。
 * 统一签名：({ size = 16, className, ...rest }) => <svg>
 * 只用 currentColor 描边，跟着宿主主题走。
 */

const React = require('react');

function makeIcon(children) {
  const Icon = function MoshuIcon(props) {
    const size = props.size === undefined ? 16 : props.size;
    const className = props.className;
    const rest = {};
    for (const key in props) {
      if (key !== 'size' && key !== 'className' && Object.prototype.hasOwnProperty.call(props, key)) rest[key] = props[key];
    }
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.65}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className}
        {...rest}
      >
        {children}
      </svg>
    );
  };
  return Icon;
}

const Activity = makeIcon(<path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />);

const Bell = makeIcon(
  <>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9" />
    <path d="M13.7 19.5a2 2 0 0 1-3.4 0" />
  </>
);

const BookOpen = makeIcon(
  <>
    <path d="M12 7.5V20" />
    <path d="M3.5 4.5H9A3 3 0 0 1 12 7.5V20a2.5 2.5 0 0 0-2.5-2.5h-6z" />
    <path d="M20.5 4.5H15A3 3 0 0 0 12 7.5V20a2.5 2.5 0 0 1 2.5-2.5h6z" />
  </>
);

const BrainCircuit = makeIcon(
  <>
    <path d="M12 18.4a3 3 0 0 1-6-.8 3.2 3.2 0 0 1-1.8-5.5A3.3 3.3 0 0 1 6 6.2a3 3 0 0 1 6 .9z" />
    <path d="M12 18.4a3 3 0 0 0 6-.8 3.2 3.2 0 0 0 1.8-5.5A3.3 3.3 0 0 0 18 6.2a3 3 0 0 0-6 .9z" />
    <path d="M12 7.4v11.2" />
    <path d="M9.3 11.6h5.4" />
    <circle cx="12" cy="11.6" r="0.95" />
  </>
);

const Check = makeIcon(<path d="M20 6.5 9.5 17 4.5 12" />);

const CheckCircle2 = makeIcon(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m8.4 12.3 2.5 2.5 4.7-5.2" />
  </>
);

const ChevronDown = makeIcon(<path d="m6.5 9.5 5.5 5.5 5.5-5.5" />);

const ChevronRight = makeIcon(<path d="m9.5 6.5 5.5 5.5-5.5 5.5" />);

const CircleHelp = makeIcon(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2-2.4 3.5" />
    <path d="M12 16.9h.01" />
  </>
);

const Command = makeIcon(
  <path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H17a2.5 2.5 0 1 0-2.5-2.5v11A2.5 2.5 0 1 0 17 15H6.5A2.5 2.5 0 1 0 9 17.5z" />
);

const Download = makeIcon(
  <>
    <path d="M12 4v11" />
    <path d="m7.5 10.8 4.5 4.5 4.5-4.5" />
    <path d="M4.8 19.5h14.4" />
  </>
);

const FileText = makeIcon(
  <>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <path d="M14 3.5v5h5" />
    <path d="M8.4 13h7.2" />
    <path d="M8.4 16.8h4.6" />
  </>
);

const Hash = makeIcon(
  <>
    <path d="M9.6 4.2 8 19.8" />
    <path d="M16 4.2l-1.6 15.6" />
    <path d="M4.6 9h15" />
    <path d="M3.9 15h15" />
  </>
);

const LibraryBig = makeIcon(
  <>
    <path d="M4.6 4.2h3.2v15.6H4.6z" />
    <path d="M10.2 4.2h3.2v15.6h-3.2z" />
    <path d="m16.4 5.4 2.7-.7 2.4 14.4-2.7.7z" />
  </>
);

// 配合 .is-spinning 使用：只有一段开口圆弧，旋转时方向清楚。
const LoaderCircle = makeIcon(<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4" />);

const Map = makeIcon(
  <>
    <path d="M9 4.2 3.4 6.4v13.4L9 17.6l6 2.2 5.6-2.2V4.2L15 6.4z" />
    <path d="M9 4.2v13.4" />
    <path d="M15 6.4v13.4" />
  </>
);

const MessageSquareText = makeIcon(
  <>
    <path d="M20.4 15.4a2 2 0 0 1-2 2H8.6L4.2 20.6V6a2 2 0 0 1 2-2h12.2a2 2 0 0 1 2 2z" />
    <path d="M8.4 9h7.8" />
    <path d="M8.4 12.8h5" />
  </>
);

const Moon = makeIcon(<path d="M20.4 14.6A8.4 8.4 0 0 1 9.4 3.6a8.4 8.4 0 1 0 11 11z" />);

const Network = makeIcon(
  <>
    <circle cx="12" cy="4.9" r="2.2" />
    <circle cx="5.1" cy="18.6" r="2.2" />
    <circle cx="18.9" cy="18.6" r="2.2" />
    <path d="M10.6 6.9 6.5 16.6" />
    <path d="M13.4 6.9l4.1 9.7" />
    <path d="M7.4 18.6h9.2" />
  </>
);

const PanelLeftClose = makeIcon(
  <>
    <rect x="4.4" y="4.6" width="15.2" height="14.8" rx="2.2" />
    <path d="M9.6 4.6v14.8" />
    <path d="m16.2 9.6-2.9 2.4 2.9 2.4" />
  </>
);

const PanelRightClose = makeIcon(
  <>
    <rect x="4.4" y="4.6" width="15.2" height="14.8" rx="2.2" />
    <path d="M14.4 4.6v14.8" />
    <path d="m11 9.6 2.9 2.4-2.9 2.4" />
  </>
);

const PanelRightOpen = makeIcon(
  <>
    <rect x="4.4" y="4.6" width="15.2" height="14.8" rx="2.2" />
    <path d="M14.4 4.6v14.8" />
    <path d="m17.2 9.6-2.9 2.4 2.9 2.4" />
  </>
);

const PenLine = makeIcon(
  <>
    <path d="m14.6 4.6 4.8 4.8L9.2 19.6H4.4v-4.8z" />
    <path d="m12.6 6.6 4.8 4.8" />
  </>
);

const Plus = makeIcon(
  <>
    <path d="M12 5.2v13.6" />
    <path d="M5.2 12h13.6" />
  </>
);

const Route = makeIcon(
  <>
    <circle cx="6" cy="18.8" r="2.3" />
    <circle cx="18" cy="5.2" r="2.3" />
    <path d="M8.3 18.8h5a3.6 3.6 0 0 0 0-7.2h-2.6a3.6 3.6 0 0 1 0-7.2h5" />
  </>
);

const Save = makeIcon(
  <>
    <rect x="4.4" y="4.6" width="15.2" height="15.2" rx="2.2" />
    <path d="M8.6 4.6v4.8h6.8V4.6" />
    <path d="M8.6 19.8v-6.4h6.8v6.4" />
  </>
);

const ScanSearch = makeIcon(
  <>
    <path d="M4.2 8.4V6.4a2.2 2.2 0 0 1 2.2-2.2h2" />
    <path d="M15.6 4.2h2a2.2 2.2 0 0 1 2.2 2.2v2" />
    <path d="M19.8 15.6v2a2.2 2.2 0 0 1-2.2 2.2h-2" />
    <path d="M8.4 19.8h-2a2.2 2.2 0 0 1-2.2-2.2v-2" />
    <circle cx="11.4" cy="11.4" r="3.2" />
    <path d="m13.8 13.8 2.9 2.9" />
  </>
);


const Mountain = makeIcon(
  <>
    <path d="m3 19 6.2-10.4a1 1 0 0 1 1.7 0L13 12l1.7-2.6a1 1 0 0 1 1.7 0L21 19Z" />
    <path d="M3 19h18" />
  </>
);

const Undo = makeIcon(
  <>
    <path d="M4 9h9.2a5 5 0 0 1 0 10H8" />
    <path d="m7.6 5.4-3.6 3.6 3.6 3.6" />
  </>
);

const Redo = makeIcon(
  <>
    <path d="M20 9h-9.2a5 5 0 0 0 0 10H16" />
    <path d="m16.4 5.4 3.6 3.6-3.6 3.6" />
  </>
);

const Grid2 = makeIcon(
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" />
  </>
);

const Magnet = makeIcon(
  <>
    <path d="M6 4v8a6 6 0 0 0 12 0V4" />
    <path d="M6 10h4M14 10h4" />
    <path d="M6 4h4M14 4h4" />
  </>
);

const Copy = makeIcon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 6.6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.6" />
  </>
);

const Layers = makeIcon(
  <>
    <path d="m12 3.6 8 4.2-8 4.2-8-4.2z" />
    <path d="m4 12.4 8 4.2 8-4.2" />
    <path d="m4 16.6 8 4.2 8-4.2" />
  </>
);

const Merge = makeIcon(
  <>
    <circle cx="8" cy="8" r="3.4" />
    <circle cx="16" cy="16" r="3.4" />
    <path d="M10.6 10.6l2.8 2.8" />
  </>
);

const Search = makeIcon(
  <>
    <circle cx="11" cy="11" r="6.6" />
    <path d="m19.8 19.8-4.7-4.7" />
  </>
);

const Settings2 = makeIcon(
  <>
    <path d="M4.2 7.4h8.6" />
    <circle cx="15.2" cy="7.4" r="2.4" />
    <path d="M17.6 7.4h2.2" />
    <path d="M4.2 16.6h2" />
    <circle cx="8.8" cy="16.6" r="2.4" />
    <path d="M11.2 16.6h8.6" />
  </>
);

const Sparkles = makeIcon(
  <>
    <path d="M11.2 3.8l1.8 4.4 4.4 1.8-4.4 1.8-1.8 4.4-1.8-4.4L5 10l4.4-1.8z" />
    <path d="m18.4 15.2.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
  </>
);

const Sun = makeIcon(
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 3.2v2.2" />
    <path d="M12 18.6v2.2" />
    <path d="M3.2 12h2.2" />
    <path d="M18.6 12h2.2" />
    <path d="m5.9 5.9 1.6 1.6" />
    <path d="m16.5 16.5 1.6 1.6" />
    <path d="m18.1 5.9-1.6 1.6" />
    <path d="m7.5 16.5-1.6 1.6" />
  </>
);

const X = makeIcon(
  <>
    <path d="m6.4 6.4 11.2 11.2" />
    <path d="m17.6 6.4-11.2 11.2" />
  </>
);

const Zap = makeIcon(<path d="M13.4 3.2 5.8 13.6h5.4L10.6 20.8l7.6-10.4h-5.4z" />);

module.exports = {
  Activity: Activity,
  Bell: Bell,
  BookOpen: BookOpen,
  BrainCircuit: BrainCircuit,
  Check: Check,
  CheckCircle2: CheckCircle2,
  ChevronDown: ChevronDown,
  ChevronRight: ChevronRight,
  CircleHelp: CircleHelp,
  Command: Command,
  Download: Download,
  FileText: FileText,
  Hash: Hash,
  LibraryBig: LibraryBig,
  LoaderCircle: LoaderCircle,
  Map: Map,
  MessageSquareText: MessageSquareText,
  Moon: Moon,
  Network: Network,
  PanelLeftClose: PanelLeftClose,
  PanelRightClose: PanelRightClose,
  PanelRightOpen: PanelRightOpen,
  PenLine: PenLine,
  Plus: Plus,
  Route: Route,
  Save: Save,
  ScanSearch: ScanSearch,
  Mountain: Mountain,
  Undo: Undo,
  Redo: Redo,
  Grid2: Grid2,
  Magnet: Magnet,
  Copy: Copy,
  Layers: Layers,
  Merge: Merge,
  Search: Search,
  Settings2: Settings2,
  Sparkles: Sparkles,
  Sun: Sun,
  X: X,
  Zap: Zap
};
