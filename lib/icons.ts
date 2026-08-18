// Centralized icon exports to avoid Turbopack chunk loading issues
// This file pre-loads all icons to prevent dynamic import errors

export { FiFile, FiChevronRight, FiChevronDown, FiGithub } from 'react-icons/fi';

export { BsFolderFill, BsFolder2Open } from 'react-icons/bs';

export {
  SiJavascript,
  SiReact,
  // react-icons exports SiCss3, not SiCss — the alias was written the wrong way
  // round and left main failing typecheck.
  SiCss3,
  SiJson,
} from 'react-icons/si';
