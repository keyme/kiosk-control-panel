/**
 * One-time setup for Cornerstone: register web image loader for http/https,
 * and cornerstone-tools (external refs + init). Call before using loadImage or tools.
 */
import * as cornerstone from 'cornerstone-core';
import cornerstoneWebImageLoader from 'cornerstone-web-image-loader';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneMath from 'cornerstone-math';
import Hammer from 'hammerjs';

let webLoaderRegistered = false;
let toolsInitialized = false;

export function registerCornerstoneWebLoader() {
  if (webLoaderRegistered) return;
  try {
    cornerstoneWebImageLoader.external.cornerstone = cornerstone;
    webLoaderRegistered = true;
  } catch (e) {
    console.error('cornerstoneSetup: register web loader failed', e);
  }
}

/**
 * One-time init for cornerstone-tools. Sets external cornerstone, cornerstoneMath, and Hammer, then init().
 * Call once before using any tools (e.g. in CornerstoneViewer when first mounting).
 */
export function initCornerstoneTools() {
  if (toolsInitialized) return;
  try {
    cornerstoneTools.external.cornerstone = cornerstone;
    cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
    cornerstoneTools.external.Hammer = Hammer;
    cornerstoneTools.init({ globalToolSyncEnabled: false });
    toolsInitialized = true;
  } catch (e) {
    console.error('cornerstoneSetup: init cornerstone-tools failed', e);
  }
}

export { cornerstone };
export { cornerstoneTools };
