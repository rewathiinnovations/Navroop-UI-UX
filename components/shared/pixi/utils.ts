import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';

/**
 * The home hero's WebGL guard. This file carried `// @ts-nocheck -- TODO: fix this`
 * until 2026-08-21, so `verify`'s `tsc --noEmit` reported green over all sixty lines
 * (F-646) — on a `pixi.js` module in the public home page's client graph, where a
 * runtime type error is a blank hero for every anonymous visitor.
 *
 * Two accesses needed narrowing rather than suppression. `Application` types
 * `renderer` and `stage` as non-optional, but they are undefined between
 * construction and `init()`, and null again after `destroy()` — which is the state
 * this function exists to detect, so the fields are read through a shape that admits
 * that. `gl` exists only on the WebGL renderer; the WebGPU one has no such field.
 */
type MaybeInitialisedApp = {
  ticker?: Application['ticker'] | null;
  stage?: Application['stage'] | null;
  renderer?: (Application['renderer'] & { gl?: WebGLRenderingContext | null }) | null;
};

export const isDestroyed = (app: Application) => {
  const { ticker, renderer, stage } = app as MaybeInitialisedApp;
  if (!ticker || !renderer || !stage || !renderer.gl) return true;

  return renderer.gl.isContextLost();
};

export const generateTexture = (app: Application, graphic: Container) => {
  if (!isDestroyed(app)) {
    return app.renderer.generateTexture(graphic);
  }

  return Texture.WHITE;
};

export const degreesToRadians = (degrees: number) => {
  return degrees * (Math.PI / 180);
};

export const imageToSprite = async (app: Application, path: string) => {
  let texture;

  if (Assets.cache.has(path)) {
    texture = Assets.cache.get(path);
  } else {
    texture = await Assets.load(path);
  }

  const sprite = Sprite.from(texture);

  return sprite;
};

export const createRenderWithFPS = (app: Application, fps: number) => {
  let lastUpdateTime = 0;

  return () => {
    const currentTime = performance.now();
    const timeSinceLastUpdate = currentTime - lastUpdateTime;

    if (timeSinceLastUpdate >= 1000 / fps) {
      app.ticker.update();
      app.render();
      lastUpdateTime = currentTime;
    }
  };
};

export const waitUntilPixiIsReady = (app: Application) => {
  return new Promise((resolve) => {
    app.canvas.addEventListener('pixi-initialized', resolve);
  });
};
