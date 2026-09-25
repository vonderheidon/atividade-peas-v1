// @ts-check
(function registerRoomScene(root) {
  'use strict';

  const DEVICE_NAMES = /** @type {readonly DeviceName[]} */ (Object.freeze(['janela', 'ar', 'ventilador', 'umidificador', 'lampada']));

  /** @type {RoomRuntime | null} */
  let activeRuntime = null;
  let fallbackActive = false;
  /** @type {SceneContainer | null} */
  let fallbackContainer = null;

  /** @type {Readonly<{ hour: number, luminosity: 'escuro' | 'adequado' | 'claro', sleep: boolean, window: DeviceValue, ac: DeviceValue, fan: DeviceValue, humidifier: DeviceValue, lamp: DeviceValue }>} */
  const SCENE_VISUAL_DEFAULTS = Object.freeze({
    hour: 6,
    luminosity: 'escuro',
    sleep: true,
    window: 'unknown',
    ac: 'unknown',
    fan: 'unknown',
    humidifier: 'unknown',
    lamp: 'unknown',
  });

  // Widen the mobile framing so the square viewport keeps more of the room visible.
  const MOBILE_CAMERA_ZOOM = 0.68;

  /**
   * @typedef {'janela' | 'ar' | 'ventilador' | 'umidificador' | 'lampada'} DeviceName
   * @typedef {'open' | 'closed' | 'on' | 'off' | 0 | 1 | 2 | 3 | 'unknown'} DeviceValue
   * @typedef {{ device: DeviceName, value: DeviceValue, status: 'confirmed' | 'unknown', confirmedAtSequence: number | null }} ConfirmedDevice
   * @typedef {{ hour: number, luminosity: 'escuro' | 'adequado' | 'claro', sleep: boolean }} SceneEnvironment
   * @typedef {{ environment?: SceneEnvironment, confirmedDevices?: Record<string, ConfirmedDevice>, sequence?: number, simulatedMinute?: number, hora?: number, luminosidade?: 'escuro' | 'adequado' | 'claro', dormir?: boolean | 0 | 1, dispositivos?: Record<string, DeviceValue>, status?: string }} PublicSnapshot
   * @typedef {{ hour: number, luminosity: 'escuro' | 'adequado' | 'claro', sleep: boolean, janela: DeviceValue, ar: DeviceValue, ventilador: DeviceValue, umidificador: DeviceValue, lampada: DeviceValue }} SceneVisualState
   * @typedef {{ matches: boolean, addEventListener?: (type: string, listener: (event: { matches: boolean }) => void) => void, removeEventListener?: (type: string, listener: (event: { matches: boolean }) => void) => void, addListener?: (listener: (event: { matches: boolean }) => void) => void, removeListener?: (listener: (event: { matches: boolean }) => void) => void }} MotionMediaQuery
   * @typedef {{
   *   THREE: any,
   *   container: any,
   *   onDeviceIntent: (deviceName: DeviceName) => void,
   *   snapshot?: PublicSnapshot,
   *   modelUrl?: string,
   *   ResizeObserver?: any,
   *   matchMedia?: (query: string) => MotionMediaQuery,
   *   requestAnimationFrame?: (callback: (timestamp: number) => void) => number,
   *   cancelAnimationFrame?: (handle: number) => void,
   * }} InitOptions
   * @typedef {{
   *   scene: any,
   *   camera: any,
   *   renderer: any,
   *   devices: Readonly<Record<DeviceName, any>>,
   * }} RoomSceneHandle
   * @typedef {RoomSceneHandle & {
   *   THREE: any,
   *   container: any,
   *   onDeviceIntent: (deviceName: DeviceName) => void,
   *   deviceParts: DeviceParts,
   *   lights: SceneLights,
   *   textures: any[],
   *   postprocessing: any,
   *   ambientOcclusion: AmbientOcclusionState,
   *   motion: SceneMotion,
   *   resizeObserver: { observe: (target: any) => void, disconnect: () => void } | null,
   *   resize: () => void,
   *   handleClick: (event: any) => void,
   *   handlePointerMove: (event: any) => void,
   *   handlePointerLeave: () => void,
   *   updateHover: (event: any) => void,
   *   clearHover: () => void,
   *   pointerMoveListener: ((event: any) => void) | null,
   *   pointerLeaveListener: (() => void) | null,
   *   previousPointerMoveListener: ((event: any) => void) | null,
   *   previousPointerLeaveListener: (() => void) | null,
   *   cameraMotion: CameraMotion,
   *   canvas: any,
   *   tooltip: any,
   *   hoveredTarget: InteractiveTarget | null,
   *   interactiveTargets: InteractiveTarget[],
   *   colorTargets: SceneColorTargets,
   *   visualState: SceneVisualState,
   *   modelRoot: any,
   *   modelLoaded: boolean,
   *   sceneReady: boolean,
   *   disposed: boolean,
   * }} RoomRuntime
   * @typedef {{
   *   windowSashes: [any, any],
   *   acLouver: any,
   *   acIndicator: any,
   *   acGlow: any,
   *   fanRotor: any,
   *   fanLampGroup: any,
   *   humidifierBody: any,
   *   humidifierMist: any,
   *   humidifierMistMaterial: any,
   *   mistState: MistParticleState,
   *   garden: any,
   *   lampMaterial: any,
   *   lampLight: any,
   *   deskLampLight: any,
   *   deskLampMaterial: any,
   *   switchRocker: any,
   *   godRays: any,
   *   godRayGroup: any,
   *   soffitLed: any,
   *   monitorDisplay: any,
   *   deskLampAlpha: any,
   * }} DeviceParts
   * @typedef {{ all: any[], wardrobe: any[], acWall: any[], profile: string }} AmbientOcclusionState
   * @typedef {{ hemisphere: any, sun: any, fill: any, bounce: any, artificialBounce?: any }} SceneLights
   * @typedef {{ reducedMotion: boolean, frame: number | null, lastFrameTime: number | null, elapsed: number, currentWindowAngle: number, fanSpeed: number, currentLouverAngle: number, currentRayOpacity: number, currentCoveIntensity: number, requestFrame: any, cancelFrame: any, mediaQuery: MotionMediaQuery | null, mediaChange: any }} SceneMotion
   * @typedef {{ root: any, deviceName: DeviceName, label: string }} InteractiveTarget
   * @typedef {{ opacity: { value: number }, count?: number, data?: any[], positions?: any, scales?: any, alphas?: any, rotations?: any }} MistParticleState
   * @typedef {{ sun: any, hemiSky: any, hemiGround: any, fill: any, bounce: any, background: any, garden: any, ray: any, mist: any, lampWarm: any, cove: any }} SceneColorTargets
   * @typedef {{ x: number, y: number, z: number }} Coordinate
   * @typedef {{ base: Coordinate, desired: Coordinate, target: Coordinate, desiredTarget: Coordinate, currentTarget: Coordinate }} CameraMotion
   * @typedef {{ init: (options: InitOptions) => RoomSceneHandle | null, updateSnapshot: (snapshot: PublicSnapshot) => void, dispose: () => void }} RoomSceneApi
   */

  const environment = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : root);

  /** @param {any} THREE @param {boolean} [isColor=false] @returns {any} */
  function createFallbackNoiseTexture(THREE, isColor) {
    if (typeof document === 'undefined') return new THREE.Texture();
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Texture();
    const imgData = ctx.createImageData(32, 32);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.floor(Math.random() * 256);
      imgData.data[i] = v;
      imgData.data[i + 1] = isColor ? Math.floor(Math.random() * 256) : v;
      imgData.data[i + 2] = isColor ? Math.floor(Math.random() * 256) : v;
      imgData.data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  /** @param {any} THREE @param {any} scene @returns {SceneLights} */
  function buildLighting(THREE, scene) {
    const hemisphere = new THREE.HemisphereLight(0xfffaf2, 0xd2c0ac, 1.65);
    hemisphere.name = 'light:hemisphere';
    scene.add(hemisphere);

    // Sun enters from the window on the right wall (positive X, angled from front-right) shining across to the floor and bed
    const sun = new THREE.DirectionalLight(0xfff5e6, 3.2);
    sun.name = 'light:sun';
    sun.position.set(6.4, 5.8, 2.2);
    sun.castShadow = true;
    if (sun.shadow) {
      sun.shadow.mapSize.set(2048, 2048);
      if (sun.shadow.camera) {
        sun.shadow.camera.near = 1.0;
        sun.shadow.camera.far = 25.0;
        sun.shadow.camera.left = -6.0;
        sun.shadow.camera.right = 6.0;
        sun.shadow.camera.top = 6.0;
        sun.shadow.camera.bottom = -6.0;
      }
      sun.shadow.bias = -0.0001;
      sun.shadow.normalBias = 0.035;
      sun.shadow.radius = 2.2;
    }
    const sunTarget = new THREE.Object3D();
    sunTarget.position.set(-0.8, 0.4, -0.8);
    scene.add(sunTarget);
    sun.target = sunTarget;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0xfff8f0, 0.95);
    fill.name = 'light:fill';
    fill.position.set(-5, 6, 6);
    scene.add(fill);

    const bounce = new THREE.DirectionalLight(0xedd6be, 0.55);
    bounce.name = 'light:bounce';
    bounce.position.set(0, 0.3, 2.0);
    const bounceTarget = new THREE.Object3D();
    bounceTarget.position.set(0, 1.5, 0);
    scene.add(bounceTarget);
    bounce.target = bounceTarget;
    scene.add(bounce);

    return { hemisphere, sun, fill, bounce };
  }

  /** @param {any} THREE @param {any} renderer */
  function configureRenderer(THREE, renderer) {
    renderer.setPixelRatio?.(Math.min(Number(environment.devicePixelRatio) || 1, 1.5));
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
  }

  // Two full-screen draws: quarter-resolution highlights and a combined output
  // with gentle bloom + edge antialiasing. AO remains baked, not another scene pass.
  function createRoomPostprocessing(THREE, renderer) {
    if (!renderer.capabilities?.isWebGL2 || !renderer.extensions?.has('EXT_color_buffer_float')) return null;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: Math.min(2, renderer.capabilities.maxSamples),
    });
    const glow = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const vertexShader = `varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }`;
    const highlight = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { source: { value: target.texture }, texel: { value: new THREE.Vector2() } },
      vertexShader,
      fragmentShader: `uniform sampler2D source; uniform vec2 texel; varying vec2 vUv;
        vec3 bright(vec2 uv) {
          vec3 c = texture2D(source, uv).rgb;
          float peak = max(c.r, max(c.g, c.b));
          return c * max(peak - 1.15, 0.0) / max(peak, 0.0001);
        }
        void main() {
          vec3 c = bright(vUv) * 4.0;
          c += bright(vUv + texel * vec2(-1.5, -1.5));
          c += bright(vUv + texel * vec2( 1.5, -1.5));
          c += bright(vUv + texel * vec2(-1.5,  1.5));
          c += bright(vUv + texel * vec2( 1.5,  1.5));
          gl_FragColor = vec4(c / 8.0, 1.0);
        }`,
    });
    const output = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { source: { value: target.texture }, glow: { value: glow.texture },
        texel: { value: new THREE.Vector2() }, glowTexel: { value: new THREE.Vector2() } },
      vertexShader,
      fragmentShader: `uniform sampler2D source; uniform sampler2D glow;
        uniform vec2 texel; uniform vec2 glowTexel; varying vec2 vUv;
        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        void main() {
          vec3 c = texture2D(source, vUv).rgb;
          vec3 n = texture2D(source, vUv + vec2(0.0, texel.y)).rgb;
          vec3 s = texture2D(source, vUv - vec2(0.0, texel.y)).rgb;
          vec3 e = texture2D(source, vUv + vec2(texel.x, 0.0)).rgb;
          vec3 w = texture2D(source, vUv - vec2(texel.x, 0.0)).rgb;
          float hi = max(luma(c), max(max(luma(n), luma(s)), max(luma(e), luma(w))));
          float lo = min(luma(c), min(min(luma(n), luma(s)), min(luma(e), luma(w))));
          float edge = smoothstep(0.08, 0.3, (hi - lo) / max(hi, 0.15));
          c = mix(c, (n + s + e + w + c * 4.0) / 8.0, edge * 0.65);
          vec3 bloom = texture2D(glow, vUv).rgb * 4.0;
          bloom += texture2D(glow, vUv + vec2(glowTexel.x, 0.0)).rgb;
          bloom += texture2D(glow, vUv - vec2(glowTexel.x, 0.0)).rgb;
          bloom += texture2D(glow, vUv + vec2(0.0, glowTexel.y)).rgb;
          bloom += texture2D(glow, vUv - vec2(0.0, glowTexel.y)).rgb;
          gl_FragColor = vec4(c + bloom * (0.07 / 8.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const triangle = new THREE.Mesh(geometry, output);
    triangle.frustumCulled = false;
    scene.add(triangle);
    const size = new THREE.Vector2();
    return {
      target, glow,
      render(world, view) {
        renderer.getDrawingBufferSize(size);
        // Bound intermediate memory even on very large/high-DPI displays.
        const scale = Math.min(1, Math.sqrt(2073600 / (size.x * size.y)));
        const width = Math.max(1, Math.round(size.x * scale));
        const height = Math.max(1, Math.round(size.y * scale));
        if (target.width !== width || target.height !== height) {
          target.setSize(width, height);
          glow.setSize(Math.max(1, Math.ceil(width / 4)), Math.max(1, Math.ceil(height / 4)));
          highlight.uniforms.texel.value.set(1 / width, 1 / height);
          output.uniforms.texel.value.set(1 / width, 1 / height);
          output.uniforms.glowTexel.value.set(1 / glow.width, 1 / glow.height);
        }
        renderer.setRenderTarget(target);
        renderer.render(world, view);
        triangle.material = highlight;
        renderer.setRenderTarget(glow);
        renderer.render(scene, camera);
        triangle.material = output;
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      },
      dispose() {
        target.dispose(); glow.dispose(); geometry.dispose(); highlight.dispose(); output.dispose();
      },
    };
  }

  function createRoomSpotlight(THREE, scene, name, color, range, angle, resolution, penumbra = 0.45) {
    const light = new THREE.SpotLight(color, 0, range, angle, penumbra, 1.3);
    light.name = name;
    light.castShadow = true;
    light.shadow.mapSize.set(resolution, resolution);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = range;
    light.shadow.bias = -0.001;
    light.shadow.normalBias = 0.025;
    light.shadow.radius = 2.0;
    light.shadow.autoUpdate = false;
    scene.add(light, light.target);
    return light;
  }

  // Cache fixed shadows. Only moving casters/light positions invalidate maps;
  // camera parallax and changes of light intensity do not. Cap motion refresh at 30 Hz.
  function updateRoomShadows(runtime) {
    const parts = runtime.deviceParts;
    const motion = runtime.motion;
    const stamp = [motion.currentWindowAngle, parts.fanRotor?.rotation.y || 0,
      motion.currentLouverAngle, parts.switchRocker?.rotation.x || 0].map(n => n.toFixed(3)).join(',');
    const now = environment.performance?.now?.() ?? Date.now();
    for (const light of [runtime.lights.sun, parts.lampLight, parts.deskLampLight]) {
      const shadow = light.shadow;
      if (!shadow) continue;
      shadow.autoUpdate = false;
      if (light.intensity < 0.001) { shadow.needsUpdate = false; continue; }
      const signature = stamp + ',' + light.position.toArray().map(n => n.toFixed(3)).join(',');
      const cached = light.userData.roomShadow;
      if (!shadow.map || !cached || (signature !== cached.signature
        && (motion.reducedMotion || now - cached.time >= 33))) {
        shadow.needsUpdate = true;
        light.userData.roomShadow = { signature, time: now };
      }
    }
  }

  /** @param {any} THREE @param {any} parent */
  function buildHumidifierMist(THREE, parent) {
    const mistGroup = new THREE.Group();
    mistGroup.name = 'humidifier:mist';
    mistGroup.visible = isActiveDevice(SCENE_VISUAL_DEFAULTS.humidifier);

    const opacity = { value: isActiveDevice(SCENE_VISUAL_DEFAULTS.humidifier) ? 1.0 : 0.0 };

    // Texturas de ruído (Voronoi/Celular e Perlin RGB para domain warping)
    const textureLoader = new THREE.TextureLoader();
    const noisePath = '/static/simulador/textures/noises/';

    const fallbackCellular = createFallbackNoiseTexture(THREE, false);
    const fallbackPerlin = createFallbackNoiseTexture(THREE, true);

    const cellularTexture = textureLoader.load(
      noisePath + 'grayscale-256x256.png',
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        if (mistMaterial && mistMaterial.uniforms && mistMaterial.uniforms.uCellularTexture) {
          mistMaterial.uniforms.uCellularTexture.value = tex;
        }
      },
      undefined,
      () => { /* usa fallback silenciosamente */ }
    );
    cellularTexture.wrapS = THREE.RepeatWrapping;
    cellularTexture.wrapT = THREE.RepeatWrapping;
    cellularTexture.generateMipmaps = false;
    cellularTexture.minFilter = THREE.LinearFilter;
    cellularTexture.magFilter = THREE.LinearFilter;

    const perlinTexture = textureLoader.load(
      noisePath + 'rgb-256x256.png',
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        if (mistMaterial && mistMaterial.uniforms && mistMaterial.uniforms.uPerlinTexture) {
          mistMaterial.uniforms.uPerlinTexture.value = tex;
        }
      },
      undefined,
      () => { /* usa fallback silenciosamente */ }
    );
    perlinTexture.wrapS = THREE.RepeatWrapping;
    perlinTexture.wrapT = THREE.RepeatWrapping;
    perlinTexture.generateMipmaps = false;
    perlinTexture.minFilter = THREE.LinearFilter;
    perlinTexture.magFilter = THREE.LinearFilter;

    // Shader Material baseado no modelo Three.js VFX Flames adaptado para vapor ultrassônico físico
    const mistMaterial = typeof THREE.ShaderMaterial === 'function'
      ? new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uGlobalOpacity: opacity,
          uCellularTexture: { value: cellularTexture || fallbackCellular },
          uPerlinTexture: { value: perlinTexture || fallbackPerlin },
          uWind: { value: new THREE.Vector2(0, 0) },
          uLightColor: { value: new THREE.Color(1, 1, 1) },
        },
        vertexShader: `
          uniform vec2 uWind;
          varying vec2 vUv;

          void main() {
            vUv = uv;

            // Billboarding cilíndrico orientado horizontalmente para a câmera
            vec4 modelCenterInView = modelViewMatrix * vec4(0.0, position.y, 0.0, 1.0);
            vec4 mvPosition = modelCenterInView;
            mvPosition.x += position.x;

            // Deflexão suave de vento e correntes de ar do quarto
            float windFactor = pow(clamp(uv.y, 0.0, 1.0), 1.35) * 2.8;
            vec3 windWorld = vec3(uWind.x, 0.0, uWind.y) * windFactor;
            vec4 windView = viewMatrix * vec4(windWorld, 0.0);
            mvPosition.xyz += windView.xyz;

            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uGlobalOpacity;
          uniform sampler2D uCellularTexture;
          uniform sampler2D uPerlinTexture;
          uniform vec3 uLightColor;
          varying vec2 vUv;

          void main() {
            vec2 uv = vUv;
            float t = uTime;
            float y = uv.y;

            // 1. Instabilidade convectiva ao longo da altura:
            // Quase zero no bocal (jato laminar estável), cresce progressivamente
            float turbStrength = smoothstep(0.04, 0.40, y);

            // 2. Double-pass Displaced Perlin Warp (Domain Warping estritamente temporal uniforme)
            // Velocidades de scroll constantes para evitar compressão espacial de coordenadas
            vec2 warpCoord1 = vec2(uv.x * 1.2, uv.y * 0.9 - t * 0.40);
            vec2 disp1 = (texture2D(uPerlinTexture, warpCoord1).rg - 0.5) * 2.0;

            vec2 warpCoord2 = vec2(uv.x * 2.0, uv.y * 1.4 - t * 0.70) + disp1 * 0.40;
            vec2 disp2 = (texture2D(uPerlinTexture, warpCoord2).ba - 0.5) * 2.0;

            vec2 totalWarp = disp1 * 0.55 + disp2 * 0.45;

            // 3. Meandro em onda S contínua (sway sinuoso da coluna de vapor)
            float sWave = sin(t * 2.5 - y * 7.5) * 0.058;
            float spineOffset = (sWave + totalWarp.x * 0.11) * turbStrength;

            vec2 warpedUv = uv;
            warpedUv.x += spineOffset;

            // Vetor de rotação de vórtice (curl perpendicular para redemoinhos circulares reais)
            vec2 rotCurl = vec2(disp2.y, -disp2.x);

            // 4. Tufos volumosos e vórtices de condensação (dual-scale Voronoi)
            vec2 cellUv1 = vec2(warpedUv.x * 1.5, warpedUv.y * 1.2 - t * 0.55) + rotCurl * (0.26 * turbStrength) + totalWarp * 0.20;
            float cellNoise1 = texture2D(uCellularTexture, cellUv1).r;
            float puffBulge1 = 1.0 - smoothstep(0.05, 0.72, cellNoise1);

            vec2 cellUv2 = vec2(warpedUv.x * 2.8, warpedUv.y * 2.2 - t * 0.85) + rotCurl * (0.32 * turbStrength);
            float cellNoise2 = texture2D(uCellularTexture, cellUv2).r;
            float puffBulge2 = 1.0 - smoothstep(0.08, 0.76, cellNoise2);

            float combinedPuff = puffBulge1 * 0.72 + puffBulge2 * 0.28;

            // Textura Perlin de suporte para enriquecer o interior das nuvens
            vec2 billowUv = vec2(warpedUv.x * 1.8, warpedUv.y * 1.4 - t * 0.65) + rotCurl * 0.20 + totalWarp * 0.20;
            float billowTex = texture2D(uPerlinTexture, billowUv).r;

            // 5. Conicidade base da coluna e modulação pelos tufos de condensação
            // Largura dobrada: base precisa no bocal, abrindo em coluna generosa e volumosa
            float baseRadius = mix(0.024, 0.245, pow(clamp(y, 0.0, 1.0), 0.58));
            float localRadius = baseRadius * (0.70 + combinedPuff * 0.52);

            // Distância ao centro ondulante e função de forma contínua
            float dist = abs(warpedUv.x - 0.5);
            float shape = 1.0 - (dist / max(localRadius, 0.001));

            // Transparência aprimorada (opacidade reduzida para permitir ver através da névoa)
            float density = smoothstep(0.0, 0.45, shape) * 0.75;

            // Variação interna de relevo e dobras de nuvem (profundidade volumétrica translúcida)
            float internalSwirl = mix(0.72 + billowTex * 0.38, 1.0, smoothstep(0.20, 0.70, shape));
            density *= internalSwirl;

            // 6. Camada secundária de volutas (mechas que dançam nas curvas)
            vec2 warpCoord3 = vec2(uv.x * 2.2, uv.y * 1.8 - t * 0.95) + disp2 * 0.35;
            vec2 disp3 = (texture2D(uPerlinTexture, warpCoord3).rg - 0.5) * 2.0;
            float dist2 = abs(uv.x - 0.5 + (sin(t * 3.0 - y * 9.5) * 0.05 + disp3.x * 0.10) * turbStrength);
            float shape2 = 1.0 - (dist2 / max(baseRadius * 1.25, 0.001));
            float wisps = smoothstep(0.0, 0.40, shape2) * combinedPuff * 0.20 * turbStrength;

            density = clamp(density + wisps, 0.0, 1.0);

            // 7. Jato na saída do bocal (concentrado, porém com translucidez de vapor d'água)
            float nozzleJet = smoothstep(0.12, 0.01, y) * smoothstep(0.85, 0.05, dist / max(baseRadius, 0.001));
            density = mix(density, 0.85, nozzleJet * 0.80);

            // 8. Entrada no bocal e evaporação suave no ar (sem cortes)
            float baseFade = smoothstep(0.001, 0.018, y);
            float topFade = smoothstep(0.98, 0.52, y);
            float topDissolve = pow(clamp(y, 0.0, 1.0), 1.4) * (1.0 - combinedPuff * 0.50) * 0.25;
            density = clamp(density - topDissolve, 0.0, 1.0);

            // Opacidade calibrada para maior transparência (pico ~0.65)
            float alpha = clamp(density * baseFade * topFade * uGlobalOpacity * 0.45, 0.0, 1.0);

            if (alpha < 0.003) discard;

            // 9. Coloração e espalhamento de luz (Mie scattering)
            vec3 coreWhite = vec3(1.0, 1.0, 1.0);
            vec3 edgeSoft = vec3(0.94, 0.96, 0.98);
            float coreFactor = smoothstep(0.25, 0.75, shape);
            vec3 mistColor = mix(edgeSoft, coreWhite, max(nozzleJet, coreFactor * 0.75 + combinedPuff * 0.25));

            vec3 finalColor = mistColor * uLightColor;

            gl_FragColor = vec4(finalColor, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
      })
      : new THREE.MeshBasicMaterial({ color: 0xe9f6ff, transparent: true, opacity: 0.45, depthWrite: false });

    // Geometria em plano vertical com largura expandida para permitir o dobro de amplitude
    const vaporGeometry = new THREE.PlaneGeometry(1.30, 1.45, 32, 48);
    vaporGeometry.translate(0, 0.725, 0);

    const vaporMesh = new THREE.Mesh(vaporGeometry, mistMaterial);
    vaporMesh.raycast = () => { };
    vaporMesh.name = 'humidifierVapor';

    mistGroup.add(vaporMesh);
    mistGroup.material = mistMaterial;
    parent.add(mistGroup);

    const mistState = { opacity };
    return { mistGroup, mistMaterial, mistState };
  }

  /** @param {any} THREE @param {any} scene */
  function buildGodRays(THREE, scene) {
    const rays = new THREE.Group();
    rays.name = 'atmosphere:sun-rays';
    scene.add(rays);
    return { rays, rayMaterial: null };
  }

  /** @param {RoomRuntime} runtime @param {string} [modelUrl] */
  function loadRoomModel(runtime, modelUrl = '/static/simulador/models/quarto.glb') {
    const THREE = runtime.THREE;
    const LoaderClass = THREE.GLTFLoader || environment.THREE?.GLTFLoader;

    if (!LoaderClass) {
      console.warn('GLTFLoader não encontrado no namespace THREE. Verifique se vendor/GLTFLoader.min.js foi carregado.');
      showWebGLFallback('O carregador da cena 3D não foi encontrado.');
      return;
    }

    setWebGLLoadingState('loading', 'Baixando modelo e materiais...');
    const loader = new LoaderClass();
    loader.load(
      modelUrl,
      (gltf) => {
        if (runtime.disposed) return;
        setWebGLLoadingState('loading', 'Preparando iluminação e interações...');
        const model = gltf.scene;
        runtime.modelRoot = model;

        // Calculate bounding box and scale to standard ~8.8 units
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const targetScale = 8.8 / Math.max(size.x, 1);

        const piso = model.getObjectByName('Arq_Piso');
        const pisoBox = piso ? new THREE.Box3().setFromObject(piso) : box;
        const floorTopY = piso ? pisoBox.max.y : box.min.y;

        model.scale.setScalar(targetScale);
        model.position.x = -center.x * targetScale;
        model.position.y = -floorTopY * targetScale;
        model.position.z = -center.z * targetScale;
        model.updateMatrixWorld(true);

        // Configure shadows, transparency, and prevent shadow leaks
        model.traverse((child) => {
          if (child.isMesh) {
            const name = child.name || '';
            const isGarden = name.includes('Plano_Jardim') || name.includes('Jardim');
            const isWardrobe = name.includes('Caixas_Guarda_Roupa');
            const isAcWall = name === 'Arq_Parede_Fundo';
            const isGlass = name.includes('glass') || name.includes('Glass')
              || (child.material && (child.material.name?.includes('Glass') || child.material.transmission > 0));

            if (isGarden) {
              child.castShadow = false;
              child.receiveShadow = false;
              if (child.material) {
                if (child.material.emissive) child.material.emissive.setHex(0x000000);
                child.material.emissiveIntensity = 0;
                runtime.deviceParts.garden = child.material;
              }
            } else if (isGlass) {
              child.castShadow = false;
              child.receiveShadow = false;
              if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((mat) => {
                  mat.transparent = true;
                  mat.opacity = 0.15;
                  mat.transmission = 0;
                  mat.depthWrite = false;
                  mat.roughness = 0.08;
                  if (mat.color) mat.color.setHex(0xffffff);
                  mat.needsUpdate = true;
                });
              }
            } else {
              child.castShadow = true;
              child.receiveShadow = true;
            }

            if (child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach((mat) => {
                mat.shadowSide = THREE.FrontSide;
                if (mat.aoMap) {
                  mat.userData = mat.userData || {};
                  if (!Number.isFinite(mat.userData.roomAoBaseIntensity)) {
                    mat.userData.roomAoBaseIntensity = Number(mat.aoMapIntensity || 1);
                  }
                  const bucket = isWardrobe ? runtime.ambientOcclusion.wardrobe
                    : isAcWall ? runtime.ambientOcclusion.acWall : runtime.ambientOcclusion.all;
                  if (!bucket.includes(mat)) bucket.push(mat);
                }
                // Calibragem do piso de madeira laminada carvalho
                if (name === 'Arq_Piso' || mat.name?.includes('Piso')) {
                  mat.roughness = 0.40;
                  mat.metalness = 0.02;
                }
                // Folhagens com recorte nítido e sem artefatos de ordenação
                if (mat.name?.includes('Folhas') || mat.name?.includes('Planta')) {
                  mat.alphaTest = 0.35;
                  mat.depthWrite = true;
                  mat.transparent = false;
                  mat.roughness = 0.55;
                }
              });
            }
          }
        });

        // Abajur de mesa (Luz artificial acolhedora)
        const deskLampMesh = model.getObjectByName('DeskLamp_DeskLamp_0') || model.getObjectByName('DeskLamp');
        if (deskLampMesh) {
          const lampPos = new THREE.Vector3();
          const shade = model.getObjectByName('DeskLamp_Alpha_0') || deskLampMesh;
          const shadeBox = new THREE.Box3().setFromObject(shade);
          shadeBox.getCenter(lampPos);
          lampPos.y = shadeBox.min.y - 0.025;
          if (runtime.deviceParts.deskLampLight) {
            runtime.deviceParts.deskLampLight.position.copy(lampPos);
            runtime.deviceParts.deskLampLight.target.position.set(lampPos.x - 0.45, 0.8, lampPos.z - 0.35);
          }
          if (deskLampMesh.material) {
            const dMat = Array.isArray(deskLampMesh.material) ? deskLampMesh.material[0] : deskLampMesh.material;
            runtime.deviceParts.deskLampMaterial = dMat;
            if (dMat && dMat.emissive) {
              dMat.emissive.setHex(0x000000);
              dMat.emissiveIntensity = 0.0;
            }
          }
        }
        const deskLampAlphaMesh = model.getObjectByName('DeskLamp_Alpha_0');
        if (deskLampAlphaMesh && deskLampAlphaMesh.material) {
          const aMat = Array.isArray(deskLampAlphaMesh.material) ? deskLampAlphaMesh.material[0] : deskLampAlphaMesh.material;
          runtime.deviceParts.deskLampAlpha = aMat;
          if (aMat && aMat.emissive) {
            aMat.emissive.setHex(0x000000);
            aMat.emissiveIntensity = 0.0;
          }
        }

        // 1. Ventilador
        const fanRotor = model.getObjectByName('Ventilador_Rotor') || model.getObjectByName('Object_4.004') || model.getObjectByName('Circle_0');
        const fanLuminaria = model.getObjectByName('Ventilador_Luminaria') || model.getObjectByName('Object_5.001');
        const fanRoot = model.getObjectByName('Asset_Ventilador_Teto') || fanRotor || model;

        if (fanRotor) runtime.deviceParts.fanRotor = fanRotor;

        let lampMat = null;
        if (fanLuminaria) {
          fanLuminaria.traverse((child) => {
            if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              const found = mats.find((m) => m && (m.name === 'Mat_Ventilador_Luz' || m.name?.includes('Luz')));
              if (found && !lampMat) lampMat = found;
            }
          });
          if (!lampMat && fanLuminaria.material) {
            lampMat = Array.isArray(fanLuminaria.material) ? fanLuminaria.material[0] : fanLuminaria.material;
          }
        }
        if (!lampMat) {
          lampMat = new THREE.MeshStandardMaterial({
            color: 0xfffaed,
            emissive: 0x111111,
            emissiveIntensity: 0,
            roughness: 0.2,
          });
          if (fanLuminaria) fanLuminaria.material = lampMat;
        }
        runtime.deviceParts.lampMaterial = lampMat;

        // Position lamp light at the fan fixture
        const lampWorldPos = new THREE.Vector3();
        if (fanLuminaria) {
          const fixtureBox = new THREE.Box3().setFromObject(fanLuminaria);
          fixtureBox.getCenter(lampWorldPos);
          lampWorldPos.y = fixtureBox.min.y - 0.035;
        }
        else lampWorldPos.set(0, 3.8, 0);
        runtime.deviceParts.lampLight.position.copy(lampWorldPos);
        runtime.deviceParts.lampLight.target.position.set(lampWorldPos.x, 0, lampWorldPos.z);

        // 2. Janela
        const sashLeft = model.getObjectByName('Janela_Folha_Esquerda');
        const sashRight = model.getObjectByName('Janela_Folha_Direita');
        const windowRoot = model.getObjectByName('Asset_Janela') || sashLeft || model;
        if (sashLeft && sashRight) {
          runtime.deviceParts.windowSashes = [sashLeft, sashRight];
        }

        // 3. Ar-condicionado
        const acLouver = model.getObjectByName('Asset_Ar_Louver');
        const acIndicatorMesh = model.getObjectByName('Asset_Ar_Indicator');
        const acRoot = model.getObjectByName('Asset_Ar_Condicionado_New') || acLouver || model;

        if (acLouver) {
          runtime.deviceParts.acLouver = acLouver;
          runtime.deviceParts.acLouverBaseX = acLouver.rotation.x;
        }
        let acMat = null;
        if (acIndicatorMesh && acIndicatorMesh.material) {
          acMat = Array.isArray(acIndicatorMesh.material) ? acIndicatorMesh.material[0] : acIndicatorMesh.material;
        }
        if (!acMat) {
          model.traverse((child) => {
            if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              const found = mats.find((m) => m && (m.name === 'Mat_Ar_Indicator' || m.name?.includes('Ar_Indicator')));
              if (found && !acMat) acMat = found;
            }
          });
        }
        if (acMat) {
          runtime.deviceParts.acIndicator = acMat;
          if (acMat.emissive) {
            acMat.emissive.setHex(0x000000);
            acMat.emissiveIntensity = 0.0;
          }
        }

        // Monitor (desliga junto com as luzes no modo escuro)
        let monitorMat = null;
        model.traverse((child) => {
          if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            const found = mats.find((m) => m && (m.name === 'Mat_Monitor_Display' || m.name?.includes('Display')));
            if (found && !monitorMat) monitorMat = found;
          }
        });
        if (monitorMat) {
          runtime.deviceParts.monitorDisplay = monitorMat;
        }

        // 4. Interruptor de luz na parede
        const switchRocker = model.getObjectByName('Switch_Rocker');
        const switchPlate = model.getObjectByName('Switch_Plate');
        const switchRoot = model.getObjectByName('Asset_Interruptor') || switchRocker || switchPlate || model;

        if (switchRocker) runtime.deviceParts.switchRocker = switchRocker;

        // 5. Umidificador & Ponto de emissão de vapor
        const umidBico = model.getObjectByName('Umidificador_Bico');
        const umidRoot = model.getObjectByName('Asset_Umidificador') || umidBico || model;
        runtime.deviceParts.humidifierBody = umidRoot;

        const bicoPos = new THREE.Vector3();
        if (umidBico) umidBico.getWorldPosition(bicoPos);
        else bicoPos.set(-3.0, 1.45, -2.8);
        runtime.deviceParts.humidifierMist.position.copy(bicoPos);

        // Map root devices for external references
        runtime.devices.janela = windowRoot;
        runtime.devices.ar = acRoot;
        runtime.devices.ventilador = fanRoot;
        runtime.devices.umidificador = umidRoot;
        runtime.devices.lampada = switchRoot;

        // Build interactive targets list (Switch toggles lamp, fan toggles speed)
        runtime.interactiveTargets = [
          { root: switchRoot, deviceName: 'lampada', label: 'Interruptor de luz (clique para ligar/desligar a lâmpada)' },
          { root: fanRoot, deviceName: 'ventilador', label: 'Ventilador de teto (clique: desligado / baixo / alto)' },
          { root: windowRoot, deviceName: 'janela', label: 'Janela (clique para abrir/fechar)' },
          { root: umidRoot, deviceName: 'umidificador', label: 'Umidificador (clique para ligar/desligar)' },
          { root: acRoot, deviceName: 'ar', label: 'Ar-condicionado (clique para ligar/desligar)' },
        ];

        runtime.scene.add(model);
        runtime.modelLoaded = true;
        setWebGLLoadingState('loading', 'Aquecendo a cena para uma entrada suave...');

        // Apply snapshot to new model nodes immediately
        renderAmbient(runtime, runtime.motion.elapsed, 0, true);
        prepareSceneForReveal(runtime);
      },
      (progressEvent) => {
        const loaded = Number(progressEvent?.loaded);
        const total = Number(progressEvent?.total);
        const progress = total > 0 && Number.isFinite(loaded)
          ? Math.max(0, Math.min(1, loaded / total))
          : null;
        setWebGLLoadingState('loading', progress === null
          ? 'Baixando modelo e materiais...'
          : `Carregando cena 3D... ${Math.round(progress * 100)}%`, progress);
      },
      (error) => {
        console.error('Erro ao carregar quarto.glb:', error);
        showWebGLFallback('Não foi possível carregar a cena 3D. Os controles continuam disponíveis.');
      }
    );
  }

  /** @param {number} value @param {number} fallback @param {number} minimum @param {number} maximum @returns {number} */
  function boundedNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
  }

  /** @param {DeviceValue} value @returns {boolean} */
  function isActiveDevice(value) {
    return value === 'on' || value === 'open' || value === 1 || value === 2 || value === 3;
  }

  /** @param {DeviceValue} value @returns {number} */
  function fanSpeedFor(value) {
    if (!isActiveDevice(value)) return 0;
    if (value === 1 || value === 'on') return 3.4;
    return 7.2;
  }

  /** @param {unknown} value @returns {value is 'escuro' | 'adequado' | 'claro'} */
  function isLuminosity(value) {
    return value === 'escuro' || value === 'adequado' || value === 'claro';
  }

  /** @param {unknown} value @returns {DeviceValue} */
  function normalizeDeviceValue(value) {
    if (value === 'open' || value === 'closed' || value === 'on' || value === 'off'
      || value === 0 || value === 1 || value === 2 || value === 3 || value === 'unknown') {
      return value;
    }
    return 'unknown';
  }

  /** @param {PublicSnapshot | null | undefined} snapshot @param {DeviceName} deviceName @returns {DeviceValue} */
  function confirmedValue(snapshot, deviceName) {
    const aliases = {
      janela: ['janela', 'window'],
      ar: ['ar', 'ac'],
      ventilador: ['ventilador', 'fan'],
      umidificador: ['umidificador', 'humidifier'],
      lampada: ['lampada', 'lamp'],
    };
    const sources = [snapshot?.confirmedDevices, snapshot?.dispositivos];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const deviceMap = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (source));
      for (const alias of aliases[deviceName]) {
        const candidate = deviceMap[alias];
        if (candidate === undefined) continue;
        if (candidate && typeof candidate === 'object') {
          const confirmation = /** @type {{ status?: unknown, value?: unknown }} */ (/** @type {unknown} */ (candidate));
          return confirmation.status === 'confirmed' ? normalizeDeviceValue(confirmation.value) : 'unknown';
        }
        return normalizeDeviceValue(candidate);
      }
    }
    return 'unknown';
  }

  /** @param {PublicSnapshot | null | undefined} snapshot @param {'hour' | 'luminosity' | 'sleep'} key @returns {unknown} */
  function environmentValue(snapshot, key) {
    const aliases = { hour: 'hora', luminosity: 'luminosidade', sleep: 'dormir' };
    const sources = [snapshot?.environment, snapshot];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const values = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (source));
      const value = values[key] ?? values[aliases[key]];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** @param {PublicSnapshot} snapshot @returns {boolean} */
  function isErrorSnapshot(snapshot) {
    return snapshot.status === 'erro' || snapshot.status === 'error' || snapshot.status === 'failed';
  }

  /** @param {PublicSnapshot} snapshot @returns {boolean} */
  function hasSnapshotPayload(snapshot) {
    return Boolean(snapshot.confirmedDevices || snapshot.dispositivos || snapshot.environment
      || snapshot.hora !== undefined || snapshot.luminosidade !== undefined || snapshot.dormir !== undefined);
  }

  const LIGHTING_KEYFRAMES = [
    { hour: 0, sunColor: 0x3a5278, sunIntensity: 0.06, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x101622, hemiGround: 0x06090e, hemiIntensity: 0.11, fillIntensity: 0.03, bounceIntensity: 0.01, bgColor: 0x090d12, gardenTint: 0x121a28, godRayOpacity: 0.0, coveBase: 2.2, coveColor: 0xffa044, stageBg: 'radial-gradient(circle at 50% 32%, #101620 0%, #090d14 50%, #05070a 100%)' },
    { hour: 3, sunColor: 0x364e72, sunIntensity: 0.05, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x0e141e, hemiGround: 0x05080c, hemiIntensity: 0.10, fillIntensity: 0.025, bounceIntensity: 0.008, bgColor: 0x080c10, gardenTint: 0x101824, godRayOpacity: 0.0, coveBase: 2.0, coveColor: 0xff9c40, stageBg: 'radial-gradient(circle at 50% 32%, #0e141c 0%, #080c12 50%, #040609 100%)' },
    { hour: 4, sunColor: 0x4e4a78, sunIntensity: 0.32, sunPos: [6.8, 4.2, 2.8], hemiSky: 0x222a3e, hemiGround: 0x101218, hemiIntensity: 0.32, fillIntensity: 0.12, bounceIntensity: 0.05, bgColor: 0x161b26, gardenTint: 0x2e354c, godRayOpacity: 0.04, coveBase: 5.5, coveColor: 0xffd296, stageBg: 'radial-gradient(circle at 50% 32%, #1c2030 0%, #111420 50%, #080910 100%)' },
    { hour: 5, sunColor: 0xff9e72, sunIntensity: 1.55, sunPos: [6.8, 4.6, 2.6], hemiSky: 0x6e6580, hemiGround: 0x3e3028, hemiIntensity: 0.82, fillIntensity: 0.45, bounceIntensity: 0.26, bgColor: 0x4a444c, gardenTint: 0xbf8d88, godRayOpacity: 0.18, coveBase: 7.5, coveColor: 0xffe0b6, stageBg: 'radial-gradient(circle at 50% 32%, #42384a 0%, #2a2432 50%, #19141f 100%)' },
    { hour: 6, sunColor: 0xfff0dc, sunIntensity: 3.40, sunPos: [6.4, 5.8, 2.2], hemiSky: 0xd8dbe6, hemiGround: 0xa89684, hemiIntensity: 1.65, fillIntensity: 1.05, bounceIntensity: 0.65, bgColor: 0xb4aba0, gardenTint: 0xfaf0e4, godRayOpacity: 0.24, coveBase: 6.0, coveColor: 0xffeed4, stageBg: 'radial-gradient(circle at 50% 32%, #fbf4eb 0%, #ece0cf 50%, #d8c5b2 100%)' },
    { hour: 7, sunColor: 0xffe2b8, sunIntensity: 4.20, sunPos: [6.3, 6.0, 2.1], hemiSky: 0xe8edf5, hemiGround: 0xb29f8a, hemiIntensity: 1.50, fillIntensity: 0.84, bounceIntensity: 0.58, bgColor: 0xeee7dc, gardenTint: 0xfff8ee, godRayOpacity: 0.38, coveBase: 7.0, coveColor: 0xfff2de, stageBg: 'radial-gradient(circle at 50% 32%, #ffffff 0%, #f7efe4 50%, #ebdccf 100%)' },
    { hour: 9, sunColor: 0xfff6ec, sunIntensity: 4.60, sunPos: [5.8, 6.8, 1.8], hemiSky: 0xf8fbff, hemiGround: 0xcdc0ae, hemiIntensity: 1.66, fillIntensity: 0.92, bounceIntensity: 0.65, bgColor: 0xf2ede4, gardenTint: 0xffffff, godRayOpacity: 0.28, coveBase: 6.0, coveColor: 0xfffaee, stageBg: 'radial-gradient(circle at 50% 32%, #ffffff 0%, #f6f1ea 50%, #eae2d5 100%)' },
    { hour: 12, sunColor: 0xfffaf4, sunIntensity: 4.80, sunPos: [4.8, 7.8, 1.4], hemiSky: 0xffffff, hemiGround: 0xd8ccba, hemiIntensity: 1.75, fillIntensity: 0.96, bounceIntensity: 0.70, bgColor: 0xf4efe7, gardenTint: 0xffffff, godRayOpacity: 0.22, coveBase: 5.5, coveColor: 0xfffaee, stageBg: 'radial-gradient(circle at 50% 32%, #ffffff 0%, #f6f1ea 50%, #eae2d5 100%)' },
    { hour: 15, sunColor: 0xfff4e6, sunIntensity: 4.50, sunPos: [5.5, 6.8, 1.8], hemiSky: 0xfaf8f4, hemiGround: 0xd0c2b0, hemiIntensity: 1.65, fillIntensity: 0.90, bounceIntensity: 0.64, bgColor: 0xf0eae0, gardenTint: 0xffffff, godRayOpacity: 0.25, coveBase: 6.0, coveColor: 0xfffaee, stageBg: 'radial-gradient(circle at 50% 32%, #ffffff 0%, #f6f1ea 50%, #eae2d5 100%)' },
    { hour: 17, sunColor: 0xffcc88, sunIntensity: 3.80, sunPos: [6.4, 5.2, 2.4], hemiSky: 0xffeed4, hemiGround: 0xb8987a, hemiIntensity: 1.42, fillIntensity: 0.78, bounceIntensity: 0.52, bgColor: 0xeee0cf, gardenTint: 0xffe8cf, godRayOpacity: 0.34, coveBase: 7.0, coveColor: 0xffeed4, stageBg: 'radial-gradient(circle at 50% 32%, #fdf2e4 0%, #eedbc5 50%, #d8beaa 100%)' },
    { hour: 18, sunColor: 0xff8e44, sunIntensity: 2.20, sunPos: [6.9, 3.8, 2.8], hemiSky: 0xd88878, hemiGround: 0x784a32, hemiIntensity: 0.88, fillIntensity: 0.42, bounceIntensity: 0.28, bgColor: 0x8a5852, gardenTint: 0xf59868, godRayOpacity: 0.28, coveBase: 3.8, coveColor: 0xffdfb0, stageBg: 'radial-gradient(circle at 50% 32%, #f0d4be 0%, #cf9c80 50%, #7c484e 100%)' },
    { hour: 19, sunColor: 0x9e4858, sunIntensity: 0.35, sunPos: [7.0, 3.8, 2.8], hemiSky: 0x32283e, hemiGround: 0x181018, hemiIntensity: 0.24, fillIntensity: 0.09, bounceIntensity: 0.035, bgColor: 0x1e1624, gardenTint: 0x4e2c3e, godRayOpacity: 0.04, coveBase: 3.2, coveColor: 0xffb262, stageBg: 'radial-gradient(circle at 50% 32%, #261c30 0%, #171120 50%, #0c0812 100%)' },
    { hour: 20, sunColor: 0x583852, sunIntensity: 0.12, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x1e1c2a, hemiGround: 0x0c0b12, hemiIntensity: 0.16, fillIntensity: 0.05, bounceIntensity: 0.02, bgColor: 0x12101a, gardenTint: 0x221828, godRayOpacity: 0.0, coveBase: 2.8, coveColor: 0xffa450, stageBg: 'radial-gradient(circle at 50% 32%, #1a1624 0%, #100d18 50%, #08060e 100%)' },
    { hour: 21, sunColor: 0x3d567c, sunIntensity: 0.07, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x131924, hemiGround: 0x070b10, hemiIntensity: 0.12, fillIntensity: 0.035, bounceIntensity: 0.012, bgColor: 0x090d14, gardenTint: 0x131a28, godRayOpacity: 0.0, coveBase: 2.5, coveColor: 0xff9e44, stageBg: 'radial-gradient(circle at 50% 32%, #121822 0%, #0a0e16 50%, #06080e 100%)' },
    { hour: 22, sunColor: 0x384e70, sunIntensity: 0.06, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x111622, hemiGround: 0x06080e, hemiIntensity: 0.11, fillIntensity: 0.03, bounceIntensity: 0.01, bgColor: 0x080c12, gardenTint: 0x111724, godRayOpacity: 0.0, coveBase: 2.2, coveColor: 0xff983e, stageBg: 'radial-gradient(circle at 50% 32%, #101620 0%, #090d14 50%, #05070a 100%)' },
    { hour: 23, sunColor: 0x364a6c, sunIntensity: 0.06, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x101520, hemiGround: 0x06080c, hemiIntensity: 0.10, fillIntensity: 0.025, bounceIntensity: 0.008, bgColor: 0x080c10, gardenTint: 0x101622, godRayOpacity: 0.0, coveBase: 2.0, coveColor: 0xff9438, stageBg: 'radial-gradient(circle at 50% 32%, #0e141e 0%, #080c14 50%, #04060a 100%)' },
    { hour: 24, sunColor: 0x3a5278, sunIntensity: 0.06, sunPos: [5.2, 5.0, 1.8], hemiSky: 0x101622, hemiGround: 0x06090e, hemiIntensity: 0.11, fillIntensity: 0.03, bounceIntensity: 0.01, bgColor: 0x090d12, gardenTint: 0x121a28, godRayOpacity: 0.0, coveBase: 2.2, coveColor: 0xffa044, stageBg: 'radial-gradient(circle at 50% 32%, #101620 0%, #090d14 50%, #05070a 100%)' },
  ];

  /** @param {number} first @param {number} second @param {number} amount @returns {number} */
  function interpolateHex(first, second, amount) {
    const firstRed = (first >> 16) & 0xff;
    const firstGreen = (first >> 8) & 0xff;
    const firstBlue = first & 0xff;
    const secondRed = (second >> 16) & 0xff;
    const secondGreen = (second >> 8) & 0xff;
    const secondBlue = second & 0xff;
    const red = Math.round(firstRed + (secondRed - firstRed) * amount);
    const green = Math.round(firstGreen + (secondGreen - firstGreen) * amount);
    const blue = Math.round(firstBlue + (secondBlue - firstBlue) * amount);
    return (red << 16) | (green << 8) | blue;
  }

  /** @param {number} hour @param {DeviceValue} windowState @param {SceneVisualState['luminosity']} luminosity @param {boolean} sleepMode */
  function getLightingParameters(hour, windowState, luminosity, sleepMode) {
    const normalizedHour = ((hour % 24) + 24) % 24;
    let first = LIGHTING_KEYFRAMES[0];
    let second = LIGHTING_KEYFRAMES[1];
    for (let index = 0; index < LIGHTING_KEYFRAMES.length - 1; index += 1) {
      if (normalizedHour >= LIGHTING_KEYFRAMES[index].hour && normalizedHour <= LIGHTING_KEYFRAMES[index + 1].hour) {
        first = LIGHTING_KEYFRAMES[index];
        second = LIGHTING_KEYFRAMES[index + 1];
        break;
      }
    }
    const span = second.hour - first.hour;
    const linearProgress = span > 0 ? (normalizedHour - first.hour) / span : 0;
    const progress = linearProgress * linearProgress * (3 - 2 * linearProgress);
    const lerp = (start, end) => start + (end - start) * progress;
    const isWindowOpen = windowState === 'open';
    const sunWindowMultiplier = isWindowOpen ? 1 : 0.65;
    const hemisphereWindowMultiplier = isWindowOpen ? 1 : 0.78;
    const rayWindowMultiplier = isWindowOpen ? 1 : 0.18;
    const rawCove = lerp(first.coveBase, second.coveBase);
    let coveIntensity = rawCove;
    if (luminosity === 'escuro') coveIntensity = rawCove * 1.15;
    if (luminosity === 'claro') coveIntensity = rawCove * 0.65;
    if (sleepMode && (normalizedHour >= 22 || normalizedHour < 6)) coveIntensity = 0;
    return {
      sunColor: interpolateHex(first.sunColor, second.sunColor, progress),
      sunIntensity: lerp(first.sunIntensity, second.sunIntensity) * sunWindowMultiplier,
      sunPos: { x: lerp(first.sunPos[0], second.sunPos[0]), y: lerp(first.sunPos[1], second.sunPos[1]), z: lerp(first.sunPos[2], second.sunPos[2]) },
      hemiSky: interpolateHex(first.hemiSky, second.hemiSky, progress),
      hemiGround: interpolateHex(first.hemiGround, second.hemiGround, progress),
      hemiIntensity: lerp(first.hemiIntensity, second.hemiIntensity) * hemisphereWindowMultiplier,
      fillIntensity: lerp(first.fillIntensity, second.fillIntensity) * hemisphereWindowMultiplier,
      bounceIntensity: lerp(first.bounceIntensity, second.bounceIntensity) * hemisphereWindowMultiplier,
      bgColor: interpolateHex(first.bgColor, second.bgColor, progress),
      gardenTint: interpolateHex(first.gardenTint, second.gardenTint, progress),
      godRayOpacity: lerp(first.godRayOpacity, second.godRayOpacity) * rayWindowMultiplier,
      coveIntensity,
      coveColor: interpolateHex(first.coveColor, second.coveColor, progress),
      stageBg: first.stageBg,
    };
  }

  function blendColorValue(value, target, targetHex, amount) {
    if (!value || typeof value !== 'object') return;
    if (value.lerp) value.lerp(target, amount);
    else value.setHex?.(targetHex);
  }

  function blendObjectColor(object, target, targetHex, amount) {
    if (object && object.color) blendColorValue(object.color, target, targetHex, amount);
  }

  function applyAmbientOcclusionProfile(runtime, lightParams) {
    const ao = runtime.ambientOcclusion;
    if (!ao) return;

    // Baked AO is free at runtime; only the material uniform changes with the
    // light band. Keep night contacts visible without turning the wardrobe's
    // upper shelves into a single black block.
    const isDay = lightParams.sunIntensity >= 1.0;
    const profile = isDay ? 'day' : 'night';
    if (ao.profile === profile) return;

    const setIntensity = (materials, multiplier) => {
      for (const material of materials) {
        if (!material?.aoMap) continue;
        const base = Number.isFinite(material.userData?.roomAoBaseIntensity)
          ? material.userData.roomAoBaseIntensity : Number(material.aoMapIntensity || 1);
        material.aoMapIntensity = Math.min(1.5, base * multiplier);
      }
    };

    setIntensity(ao.all, isDay ? 1.18 : 0.86);
    setIntensity(ao.wardrobe, isDay ? 1.18 : 0.74);
    setIntensity(ao.acWall, isDay ? 1.34 : 0.92);
    ao.profile = profile;
  }

  /** @param {RoomRuntime} runtime @param {number} elapsed @param {number} delta @param {boolean} [immediate=false] */
  function renderAmbient(runtime, elapsed, delta, immediate = false) {
    const safeDelta = Math.min(Math.max(delta, 0), 0.1);
    const motion = runtime.motion;
    const visualState = runtime.visualState;
    const instant = immediate || motion.reducedMotion;
    const reducedMotionEase = instant ? 1 : 1 - Math.exp(-6.8 * safeDelta);

    // 1. Janela (Folhas Móveis)
    const targetWindowAngle = isActiveDevice(visualState.janela) ? 1.30 : 0;
    let currentWindowAngle = motion.currentWindowAngle;
    currentWindowAngle += (targetWindowAngle - currentWindowAngle) * reducedMotionEase;
    motion.currentWindowAngle = currentWindowAngle;
    if (runtime.deviceParts.windowSashes[0]) {
      runtime.deviceParts.windowSashes[0].rotation.y = -currentWindowAngle;
    }
    if (runtime.deviceParts.windowSashes[1]) {
      runtime.deviceParts.windowSashes[1].rotation.y = currentWindowAngle;
    }

    // 2. Ventilador (Rotor & Pás)
    const targetFanSpeed = fanSpeedFor(visualState.ventilador);
    const fanAcceleration = targetFanSpeed > motion.fanSpeed ? 2.2 : 1.1;
    motion.fanSpeed += (targetFanSpeed - motion.fanSpeed) * (instant ? 1 : 1 - Math.exp(-fanAcceleration * safeDelta));
    if (Math.abs(motion.fanSpeed) > 0.001 && !instant && runtime.deviceParts.fanRotor) {
      runtime.deviceParts.fanRotor.rotation.y = Number(runtime.deviceParts.fanRotor.rotation.y || 0) + motion.fanSpeed * safeDelta;
    }

    // 3. Ar-condicionado (Aleta & LED)
    const baseLouverAngle = Number.isFinite(runtime.deviceParts.acLouverBaseX)
      ? runtime.deviceParts.acLouverBaseX
      : (runtime.deviceParts.acLouver ? runtime.deviceParts.acLouver.rotation.x : 0.8886);
    const targetLouverOffset = isActiveDevice(visualState.ar) ? 0.94 + Math.sin(elapsed * 1.6) * 0.08 : 0;
    let currentLouverOffset = motion.currentLouverAngle;
    currentLouverOffset += (targetLouverOffset - currentLouverOffset) * (instant ? 1 : 1 - Math.exp(-6.5 * safeDelta));
    motion.currentLouverAngle = currentLouverOffset;
    if (runtime.deviceParts.acLouver) {
      runtime.deviceParts.acLouver.rotation.x = baseLouverAngle + currentLouverOffset;
    }
    if (runtime.deviceParts.acIndicator) {
      const isAcActive = isActiveDevice(visualState.ar);
      const targetAcEmissive = isAcActive ? 2.5 : 0.0;
      const currentAcEmissive = Number(runtime.deviceParts.acIndicator.emissiveIntensity || 0);
      runtime.deviceParts.acIndicator.emissiveIntensity = currentAcEmissive + (targetAcEmissive - currentAcEmissive)
        * (instant ? 1 : 1 - Math.exp(-8.0 * safeDelta));
      if (runtime.deviceParts.acIndicator.emissive) {
        runtime.deviceParts.acIndicator.emissive.setHex(isAcActive ? 0x38bdf8 : 0x000000);
      }
      const targetAcColor = isAcActive ? 0x38bdf8 : (visualState.ar === 'unknown' ? 0x334155 : 0x0f172a);
      runtime.deviceParts.acIndicator.color?.setHex?.(targetAcColor);
    }

    // 4. Lâmpada no ventilador & Interruptor na parede
    const isLampOn = isActiveDevice(visualState.lampada);
    const targetLampEmissive = isLampOn ? 1.8 : 0;
    const lampEmissiveIntensity = Number(runtime.deviceParts.lampMaterial?.emissiveIntensity || 0);
    if (runtime.deviceParts.lampMaterial) {
      runtime.deviceParts.lampMaterial.emissiveIntensity = lampEmissiveIntensity + (targetLampEmissive - lampEmissiveIntensity)
        * (instant ? 1 : 1 - Math.exp(-8.0 * safeDelta));
      runtime.deviceParts.lampMaterial.emissive?.setHex?.(isLampOn ? 0xffeaad : 0x111111);
    }
    const lampLightIntensity = Number(runtime.deviceParts.lampLight?.intensity || 0);
    if (runtime.deviceParts.lampLight) {
      runtime.deviceParts.lampLight.intensity = lampLightIntensity + ((isLampOn ? 4.0 : 0) - lampLightIntensity)
        * (instant ? 1 : 1 - Math.exp(-8.0 * safeDelta));
    }
    if (runtime.lights.artificialBounce) {
      // Low-energy indirect fill from the lamp; never enabled by darkness alone.
      runtime.lights.artificialBounce.intensity = runtime.deviceParts.lampLight.intensity * 0.085;
    }
    // Bascular a tecla do interruptor
    const targetRockerRotation = isLampOn ? -0.18 : 0.18;
    const rockerRotation = Number(runtime.deviceParts.switchRocker?.rotation?.x || 0);
    if (runtime.deviceParts.switchRocker) {
      runtime.deviceParts.switchRocker.rotation.x = rockerRotation + (targetRockerRotation - rockerRotation)
        * (instant ? 1 : 1 - Math.exp(-12.0 * safeDelta));
    }

    // 4b. Abajur de mesa (espelha o mesmo estado confirmado da lâmpada principal)
    const isDeskLampActive = isLampOn;
    const targetDeskIntensity = isDeskLampActive ? 1.1 : 0.0;
    const currentDeskIntensity = Number(runtime.deviceParts.deskLampLight?.intensity || 0);
    if (runtime.deviceParts.deskLampLight) {
      runtime.deviceParts.deskLampLight.intensity = currentDeskIntensity + (targetDeskIntensity - currentDeskIntensity)
        * (instant ? 1 : 1 - Math.exp(-6.0 * safeDelta));
    }
    if (runtime.deviceParts.deskLampMaterial) {
      const targetDeskEmissive = isDeskLampActive ? 1.0 : 0.0;
      const currentDeskEmissive = Number(runtime.deviceParts.deskLampMaterial.emissiveIntensity || 0);
      runtime.deviceParts.deskLampMaterial.emissiveIntensity = currentDeskEmissive + (targetDeskEmissive - currentDeskEmissive)
        * (instant ? 1 : 1 - Math.exp(-6.0 * safeDelta));
      runtime.deviceParts.deskLampMaterial.emissive?.setHex?.(0xffe2a8);
    }
    if (runtime.deviceParts.deskLampAlpha) {
      runtime.deviceParts.deskLampAlpha.emissive?.setHex?.(0x000000);
      runtime.deviceParts.deskLampAlpha.emissiveIntensity = 0.0;
    }

    // 4c. Monitor espelha o estado confirmado da lâmpada, assim como o abajur.
    if (runtime.deviceParts.monitorDisplay) {
      const isMonitorOn = isLampOn;
      const targetMonitorEmissive = isMonitorOn ? 1.2 : 0.0;
      const currentMonitorEmissive = Number(runtime.deviceParts.monitorDisplay.emissiveIntensity ?? 1.2);
      runtime.deviceParts.monitorDisplay.emissiveIntensity = currentMonitorEmissive + (targetMonitorEmissive - currentMonitorEmissive)
        * (instant ? 1 : 1 - Math.exp(-6.0 * safeDelta));
      if (runtime.deviceParts.monitorDisplay.emissive) {
        runtime.deviceParts.monitorDisplay.emissive.setHex(isMonitorOn ? 0xffffff : 0x000000);
      }
      if (runtime.deviceParts.monitorDisplay.color) {
        const targetColor = isMonitorOn ? 0xffffff : 0x080b11;
        runtime.deviceParts.monitorDisplay.color.setHex(targetColor);
      }
    }

    // 5. Iluminação Dinâmica 24h
    const lightParams = getLightingParameters(visualState.hour, visualState.janela, visualState.luminosity, visualState.sleep);
    const colorTargets = runtime.colorTargets;
    const lightingEase = instant ? 1 : 1 - Math.exp(-4.5 * safeDelta);

    colorTargets.sun.setHex?.(lightParams.sunColor);
    colorTargets.hemiSky.setHex?.(lightParams.hemiSky);
    colorTargets.hemiGround.setHex?.(lightParams.hemiGround);
    colorTargets.fill.setHex?.(lightParams.hemiSky);
    colorTargets.bounce.setHex?.(lightParams.hemiGround);
    colorTargets.background.setHex?.(lightParams.bgColor);
    colorTargets.garden.setHex?.(lightParams.gardenTint);
    colorTargets.ray.setHex?.(lightParams.sunColor);

    blendColorValue(runtime.scene.background, colorTargets.background, lightParams.bgColor, lightingEase);

    const sunPosition = runtime.lights.sun.position;
    sunPosition.x = Number(sunPosition.x || 0) + (lightParams.sunPos.x - Number(sunPosition.x || 0)) * lightingEase;
    sunPosition.y = Number(sunPosition.y || 0) + (lightParams.sunPos.y - Number(sunPosition.y || 0)) * lightingEase;
    sunPosition.z = Number(sunPosition.z || 0) + (lightParams.sunPos.z - Number(sunPosition.z || 0)) * lightingEase;

    const sunIntensity = Number(runtime.lights.sun.intensity || 0);
    const hemisphereIntensity = Number(runtime.lights.hemisphere.intensity || 0);
    const fillIntensity = Number(runtime.lights.fill.intensity || 0);
    const bounceIntensity = Number(runtime.lights.bounce.intensity || 0);

    runtime.lights.sun.intensity = sunIntensity + (lightParams.sunIntensity - sunIntensity) * lightingEase;
    runtime.lights.hemisphere.intensity = hemisphereIntensity + (lightParams.hemiIntensity - hemisphereIntensity) * lightingEase;
    runtime.lights.fill.intensity = fillIntensity + (lightParams.fillIntensity - fillIntensity) * lightingEase;
    runtime.lights.bounce.intensity = bounceIntensity + (lightParams.bounceIntensity - bounceIntensity) * lightingEase;

    blendObjectColor(runtime.lights.sun, colorTargets.sun, lightParams.sunColor, lightingEase);
    blendObjectColor(runtime.lights.hemisphere, colorTargets.hemiSky, lightParams.hemiSky, lightingEase);
    blendObjectColor(runtime.lights.fill, colorTargets.fill, lightParams.hemiSky, lightingEase);
    blendObjectColor(runtime.lights.bounce, colorTargets.bounce, lightParams.hemiGround, lightingEase);
    applyAmbientOcclusionProfile(runtime, lightParams);
    if (runtime.deviceParts.garden) {
      blendObjectColor(runtime.deviceParts.garden, colorTargets.garden, lightParams.gardenTint, lightingEase);
    }

    if (runtime.container.dataset && runtime.container.style && runtime.container.dataset.lastBg !== lightParams.stageBg) {
      runtime.container.dataset.lastBg = lightParams.stageBg;
      runtime.container.style.background = lightParams.stageBg;
    }

    // Feixes de luz (God rays)
    const targetRayOpacity = lightParams.godRayOpacity;
    motion.currentRayOpacity += (targetRayOpacity - motion.currentRayOpacity) * (instant ? 1 : 1 - Math.exp(-4.8 * safeDelta));
    const rayShimmer = 1 + Math.sin(elapsed * 1.5) * 0.035 + Math.sin(elapsed * 3.1) * 0.015;
    if (runtime.deviceParts.godRays) {
      runtime.deviceParts.godRays.opacity = motion.currentRayOpacity * rayShimmer;
      blendObjectColor(runtime.deviceParts.godRays, colorTargets.ray, lightParams.sunColor, instant ? 1 : 1 - Math.exp(-4.2 * safeDelta));
    }

    // 6. Vapor do Umidificador (Procedural VFX Shader)
    const mistState = runtime.deviceParts.mistState;
    const targetMistOpacity = isActiveDevice(visualState.umidificador) ? 1.0 : 0.0;
    mistState.opacity.value += (targetMistOpacity - mistState.opacity.value) * (instant ? 1 : 1 - Math.exp(-5.0 * safeDelta));

    if (runtime.deviceParts.humidifierMist) {
      runtime.deviceParts.humidifierMist.visible = mistState.opacity.value > 0.002;
    }

    const fanIsActive = isActiveDevice(visualState.ventilador);
    const fanDriftX = fanIsActive ? (visualState.ventilador === 2 ? 0.065 : 0.032) : 0;
    const fanDriftZ = fanIsActive ? (visualState.ventilador === 2 ? 0.045 : 0.022) : 0;
    const windowBreezeX = visualState.janela === 'open' ? -0.042 : 0;
    const windowBreezeZ = visualState.janela === 'open' ? 0.026 : 0;
    const windTurbulence = (fanIsActive || visualState.janela === 'open') ? Math.sin(elapsed * 2.4) * 0.015 : 0;

    const mistMat = runtime.deviceParts.humidifierMistMaterial;
    if (mistMat) {
      mistMat.opacity = 1.0;
      if (mistMat.uniforms) {
        if (mistMat.uniforms.uTime) mistMat.uniforms.uTime.value = elapsed;
        if (mistMat.uniforms.uGlobalOpacity) mistMat.uniforms.uGlobalOpacity.value = mistState.opacity.value;
        if (mistMat.uniforms.uWind) {
          mistMat.uniforms.uWind.value.set(
            fanDriftX + windowBreezeX + windTurbulence,
            fanDriftZ + windowBreezeZ
          );
        }
        if (mistMat.uniforms.uLightColor) {
          // Iluminação incidente sobre o vapor do umidificador
          const hemiIntensity = Number(runtime.lights.hemisphere?.intensity || 0);
          const hemiColor = colorTargets.hemiSky || new THREE.Color(0x101520);
          const sunIntensity = Number(runtime.lights.sun?.intensity || 0);
          const sunColor = colorTargets.sun || new THREE.Color(0x384e70);
          const fillIntensity = Number(runtime.lights.fill?.intensity || 0);

          // Luz ambiente e solar acumulada na altura do umidificador
          const ambR = hemiColor.r * hemiIntensity * 0.40 + sunColor.r * sunIntensity * 0.28 + fillIntensity * 0.15;
          const ambG = hemiColor.g * hemiIntensity * 0.40 + sunColor.g * sunIntensity * 0.28 + fillIntensity * 0.15;
          const ambB = hemiColor.b * hemiIntensity * 0.40 + sunColor.b * sunIntensity * 0.28 + fillIntensity * 0.15;

          // Luz da lâmpada de teto (se estiver acesa)
          const lampIntensity = Number(runtime.deviceParts.lampLight?.intensity || 0);
          const lampColor = colorTargets.lampWarm || new THREE.Color(0xffeedd);
          const lampFactor = lampIntensity > 0 ? (lampIntensity / 4.0) * 0.70 : 0;
          const lampR = lampColor.r * lampFactor;
          const lampG = lampColor.g * lampFactor;
          const lampB = lampColor.b * lampFactor;

          const totalLightR = Math.max(0.025, Math.min(1.15, ambR + lampR));
          const totalLightG = Math.max(0.025, Math.min(1.15, ambG + lampG));
          const totalLightB = Math.max(0.030, Math.min(1.15, ambB + lampB));

          mistMat.uniforms.uLightColor.value.setRGB(totalLightR, totalLightG, totalLightB);
        }
      }
    }

    // 7. Câmera Parallax Suave
    const cameraMotion = runtime.cameraMotion;
    const cameraEase = instant ? 1 : 1 - Math.exp(-4.5 * safeDelta);
    if (instant) {
      cameraMotion.currentTarget.x = cameraMotion.target.x;
      cameraMotion.currentTarget.y = cameraMotion.target.y;
      cameraMotion.currentTarget.z = cameraMotion.target.z;
      runtime.camera.position.set(cameraMotion.base.x, cameraMotion.base.y, cameraMotion.base.z);
    } else {
      const cameraPositionX = Number(runtime.camera.position.x || 0);
      const cameraPositionY = Number(runtime.camera.position.y || 0);
      const cameraPositionZ = Number(runtime.camera.position.z || 0);
      runtime.camera.position.x = cameraPositionX + (cameraMotion.desired.x - cameraPositionX) * cameraEase;
      runtime.camera.position.y = cameraPositionY + (cameraMotion.desired.y - cameraPositionY) * cameraEase;
      runtime.camera.position.z = cameraPositionZ + (cameraMotion.desired.z - cameraPositionZ) * cameraEase;
      cameraMotion.currentTarget.x += (cameraMotion.desiredTarget.x - cameraMotion.currentTarget.x) * cameraEase;
      cameraMotion.currentTarget.y += (cameraMotion.desiredTarget.y - cameraMotion.currentTarget.y) * cameraEase;
      cameraMotion.currentTarget.z += (cameraMotion.desiredTarget.z - cameraMotion.currentTarget.z) * cameraEase;
    }
    runtime.camera.lookAt?.(
      cameraMotion.currentTarget.x,
      cameraMotion.currentTarget.y,
      cameraMotion.currentTarget.z
    );
  }

  function renderRuntime(runtime, allowBeforeReady = false) {
    if (runtime.disposed || !runtime.modelLoaded || (!runtime.sceneReady && !allowBeforeReady)) return false;
    try {
      updateRoomShadows(runtime);
      runtime.renderer.info.autoReset = false;
      runtime.renderer.info.reset();
      if (runtime.postprocessing) runtime.postprocessing.render(runtime.scene, runtime.camera);
      else runtime.renderer.render(runtime.scene, runtime.camera);
      return true;
    } catch {
      // The scene and its controls stay usable if the optional HDR path fails.
      if (!runtime.postprocessing) return false;
      runtime.renderer.setRenderTarget(null);
      runtime.postprocessing.dispose();
      runtime.postprocessing = null;
      try { runtime.renderer.render(runtime.scene, runtime.camera); return true; } catch { return false; }
    }
  }

  function startMotion(runtime) {
    if (runtime.disposed || !runtime.modelLoaded || !runtime.sceneReady || runtime.motion.frame !== null) return;
    const request = runtime.motion.requestFrame;
    if (!request) {
      renderAmbient(runtime, 0, 0, true);
      renderRuntime(runtime);
      return;
    }
    const animate = (timestamp) => {
      if (runtime.disposed) return;
      if (runtime.motion.lastFrameTime === null) runtime.motion.lastFrameTime = timestamp;
      const delta = Math.min(Math.max((timestamp - runtime.motion.lastFrameTime) / 1000, 0), 0.1);
      runtime.motion.lastFrameTime = timestamp;
      runtime.motion.elapsed += delta;
      renderAmbient(runtime, runtime.motion.elapsed, delta);
      renderRuntime(runtime);
      runtime.motion.frame = request(animate);
    };
    runtime.motion.frame = request(animate);
  }

  function cancelMotion(runtime) {
    if (runtime.motion.frame !== null && runtime.motion.cancelFrame) {
      runtime.motion.cancelFrame(runtime.motion.frame);
    }
    runtime.motion.frame = null;
    runtime.motion.lastFrameTime = null;
  }

  function createHoverHandler(runtime) {
    const pointer = new runtime.THREE.Vector2();
    const raycaster = new runtime.THREE.Raycaster();

    return (event) => {
      if (runtime.disposed || !runtime.sceneReady) return;
      const rect = runtime.container.getBoundingClientRect?.() || {};
      const width = Math.max(1, Number(rect.width || runtime.container.clientWidth || 1));
      const height = Math.max(1, Number(rect.height || runtime.container.clientHeight || 1));
      const left = Number(rect.left || 0);
      const top = Number(rect.top || 0);
      const clientX = Number(event.clientX || 0);
      const clientY = Number(event.clientY || 0);

      pointer.set(((clientX - left) / width) * 2 - 1, -((clientY - top) / height) * 2 + 1);
      raycaster.setFromCamera(pointer, runtime.camera);

      let bestTarget = null;
      let minDistance = Infinity;

      for (const target of runtime.interactiveTargets) {
        if (!target.root) continue;
        const hits = raycaster.intersectObjects([target.root], true);
        if (hits.length > 0) {
          const dist = hits[0].distance;
          if (dist < minDistance) {
            minDistance = dist;
            bestTarget = target;
          }
        }
      }

      if (!bestTarget) {
        hideHover(runtime);
        return;
      }

      runtime.hoveredTarget = bestTarget;
      if (runtime.canvas.style) runtime.canvas.style.cursor = 'pointer';
      if (runtime.tooltip) {
        runtime.tooltip.textContent = bestTarget.label;
        if (runtime.tooltip.style) {
          const tooltipWidth = Number(runtime.tooltip.offsetWidth) || 240;
          const halfWidth = Math.ceil(tooltipWidth / 2) + 14;
          const clampedX = Math.max(halfWidth, Math.min(width - halfWidth, clientX - left));
          const clampedY = Math.max(38, Math.min(height - 24, clientY - top));
          runtime.tooltip.style.left = `${clampedX}px`;
          runtime.tooltip.style.top = `${clampedY}px`;
        }
        runtime.tooltip.classList?.add?.('is-visible');
        runtime.tooltip.setAttribute?.('aria-hidden', 'false');
      }
    };
  }

  function hideHover(runtime) {
    runtime.hoveredTarget = null;
    if (runtime.canvas?.style) runtime.canvas.style.cursor = 'default';
    if (runtime.tooltip) {
      runtime.tooltip.classList?.remove?.('is-visible');
      runtime.tooltip.setAttribute?.('aria-hidden', 'true');
    }
  }

  function createClickHandler(runtime) {
    const raycaster = new runtime.THREE.Raycaster();
    const pointer = new runtime.THREE.Vector2();
    const doc = runtime.container?.ownerDocument || (typeof document !== 'undefined' ? document : null);

    return (event) => {
      if (runtime.disposed || !runtime.sceneReady) return;
      const target = event.target;
      if (target && typeof target === 'object' && 'closest' in target && typeof target.closest === 'function' && target.closest('[data-device]')) return;

      const active = doc?.activeElement;
      if (active && typeof active.blur === 'function' && active !== doc.body) {
        active.blur();
      }
      if (runtime.focusedDevice) {
        clearDeviceFocus(runtime);
      }

      if (runtime.hoveredTarget) {
        runtime.onDeviceIntent(runtime.hoveredTarget.deviceName);
        return;
      }

      if (!runtime.modelLoaded) return;
      const rect = runtime.container.getBoundingClientRect?.() || {};
      const width = Number(rect.width || runtime.container.clientWidth || 1);
      const height = Number(rect.height || runtime.container.clientHeight || 1);
      const left = Number(rect.left || 0);
      const top = Number(rect.top || 0);
      pointer.set(((Number(event.clientX) - left) / width) * 2 - 1, -((Number(event.clientY) - top) / height) * 2 + 1);
      raycaster.setFromCamera(pointer, runtime.camera);

      for (const t of runtime.interactiveTargets) {
        if (!t.root) continue;
        const hits = raycaster.intersectObjects([t.root], true);
        if (hits.length > 0) {
          runtime.onDeviceIntent(t.deviceName);
          return;
        }
      }
    };
  }

  const DEVICE_CAMERA_FRAMING = Object.freeze({
    lampada: {
      // Enquadramento conjunto da luminária do ventilador e do abajur da mesa.
      target: { x: 0.55, y: 1.65, z: -0.45 },
      pos: { x: -3.00, y: 2.10, z: 2.10 },
    },
    umidificador: {
      target: { x: -1.0364, y: 1.1447, z: -1.2425 },
      pos: { x: -3.00, y: 2.10, z: 2.10 },
    },
    ar: {
      target: { x: -0.6233, y: 1.9864, z: -1.0117 },
      pos: { x: -3.00, y: 2.10, z: 2.10 },
    },
    ventilador: {
      target: { x: -0.0170, y: 1.9812, z: -0.5215 },
      pos: { x: -3.00, y: 2.10, z: 2.10 },
    },
    janela: {
      target: { x: 0.3056, y: 1.5880, z: -0.0976 },
      pos: { x: -3.00, y: 2.10, z: 2.10 },
    },
  });

  function applyPointerParallax(runtime, event) {
    if (!event) return;
    const rect = runtime.container?.getBoundingClientRect?.() || {};
    const width = Number(rect.width || runtime.container?.clientWidth || 1);
    const height = Number(rect.height || runtime.container?.clientHeight || 1);
    const left = Number(rect.left || 0);
    const top = Number(rect.top || 0);
    const clientX = Number(event.clientX || 0);
    const clientY = Number(event.clientY || 0);
    const normalizedX = ((clientX - left) / width) * 2 - 1;
    const normalizedY = ((clientY - top) / height) * 2 - 1;
    const motion = runtime.cameraMotion;

    // Olhar onde o mouse aponta a partir do ponto de vista interno do quarto
    const lookRangeX = normalizedX < 0 ? 1.45 : 0.85;
    const lookRangeY = normalizedY < 0 ? 0.45 : 0.55;
    const bodyShiftX = normalizedX < 0 ? 0.08 : 0.05;
    const bodyShiftY = 0.03;

    // Vetores de orientação do ponto de vista interno em pé
    motion.desiredTarget.x = motion.target.x + 0.684 * (normalizedX * lookRangeX) + 0.060 * (-normalizedY * lookRangeY);
    motion.desiredTarget.y = motion.target.y + 0.997 * (-normalizedY * lookRangeY);
    motion.desiredTarget.z = motion.target.z + 0.730 * (normalizedX * lookRangeX) - 0.056 * (-normalizedY * lookRangeY);

    // Leve oscilação de postura da pessoa em pé no quarto
    motion.desired.x = motion.base.x + 0.684 * (normalizedX * bodyShiftX);
    motion.desired.y = motion.base.y - (normalizedY * bodyShiftY);
    motion.desired.z = motion.base.z + 0.730 * (normalizedX * bodyShiftX);
  }

  /**
   * @param {RoomRuntime} runtime
   * @param {DeviceName} deviceName
   */
  function focusDevice(runtime, deviceName) {
    if (runtime.disposed || !runtime.sceneReady) return;
    const config = DEVICE_CAMERA_FRAMING[deviceName];
    if (!config) return;

    if (runtime.focusedDevice === deviceName) return;
    runtime.focusedDevice = deviceName;
    const motion = runtime.cameraMotion;

    motion.desiredTarget.x = config.target.x;
    motion.desiredTarget.y = config.target.y;
    motion.desiredTarget.z = config.target.z;

    motion.desired.x = config.pos.x;
    motion.desired.y = config.pos.y;
    motion.desired.z = config.pos.z;

    startMotion(runtime);
  }

  /**
   * @param {RoomRuntime} runtime
   */
  function clearDeviceFocus(runtime) {
    if (runtime.disposed) return;
    if (!runtime.focusedDevice) return;
    runtime.focusedDevice = null;

    if (runtime.pointerInsideContainer && runtime.lastPointerEvent) {
      applyPointerParallax(runtime, runtime.lastPointerEvent);
    } else {
      const motion = runtime.cameraMotion;
      motion.desired.x = motion.base.x;
      motion.desired.y = motion.base.y;
      motion.desired.z = motion.base.z;
      motion.desiredTarget.x = motion.target.x;
      motion.desiredTarget.y = motion.target.y;
      motion.desiredTarget.z = motion.target.z;
    }

    startMotion(runtime);
  }

  /**
   * @param {RoomRuntime} runtime
   */
  function attachDeviceHoverFocus(runtime) {
    const doc = runtime.container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return () => {};

    /** @param {any} target */
    const resolveDeviceName = (target) => {
      if (!target || typeof target !== 'object' || typeof target.closest !== 'function') return null;
      const button = target.closest('[data-device]');
      if (!button) return null;
      const device = button.getAttribute('data-device');
      return device && DEVICE_NAMES.includes(/** @type {DeviceName} */ (device)) ? /** @type {DeviceName} */ (device) : null;
    };

    const handlePointerOver = (event) => {
      const device = resolveDeviceName(event.target);
      if (device) {
        focusDevice(runtime, device);
      }
    };

    const handlePointerOut = (event) => {
      const currentDevice = resolveDeviceName(event.target);
      if (!currentDevice) return;
      const nextDevice = resolveDeviceName(event.relatedTarget);
      if (nextDevice) {
        if (nextDevice !== currentDevice) {
          focusDevice(runtime, nextDevice);
        }
        return;
      }
      if (runtime.focusedDevice === currentDevice) {
        clearDeviceFocus(runtime);
      }
    };

    const handleFocusIn = (event) => {
      const device = resolveDeviceName(event.target);
      if (!device) return;
      const el = event.target;
      if (el && typeof el.matches === 'function' && el.matches(':focus-visible')) {
        focusDevice(runtime, device);
      }
    };

    const handleFocusOut = (event) => {
      const currentDevice = resolveDeviceName(event.target);
      if (!currentDevice) return;
      const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-device]') : null;
      if (button && typeof button.matches === 'function' && button.matches(':hover')) {
        return;
      }
      const nextDevice = resolveDeviceName(event.relatedTarget);
      if (nextDevice) {
        if (nextDevice !== currentDevice) {
          focusDevice(runtime, nextDevice);
        }
        return;
      }
      if (runtime.focusedDevice === currentDevice) {
        clearDeviceFocus(runtime);
      }
    };

    doc.addEventListener('pointerover', handlePointerOver, true);
    doc.addEventListener('pointerout', handlePointerOut, true);
    doc.addEventListener('focusin', handleFocusIn, true);
    doc.addEventListener('focusout', handleFocusOut, true);

    return () => {
      doc.removeEventListener('pointerover', handlePointerOver, true);
      doc.removeEventListener('pointerout', handlePointerOut, true);
      doc.removeEventListener('focusin', handleFocusIn, true);
      doc.removeEventListener('focusout', handleFocusOut, true);
    };
  }

  function createPointerMoveHandler(runtime) {
    return (event) => {
      if (runtime.disposed || !runtime.sceneReady) return;
      runtime.lastPointerEvent = event;
      runtime.pointerInsideContainer = true;
      if (runtime.focusedDevice) return;
      runtime.updateHover(event);
      applyPointerParallax(runtime, event);
    };
  }

  function createPointerLeaveHandler(runtime) {
    return () => {
      runtime.pointerInsideContainer = false;
      runtime.clearHover();
      if (runtime.focusedDevice) return;
      const motion = runtime.cameraMotion;
      motion.desired.x = motion.base.x;
      motion.desired.y = motion.base.y;
      motion.desired.z = motion.base.z;
      motion.desiredTarget.x = motion.target.x;
      motion.desiredTarget.y = motion.target.y;
      motion.desiredTarget.z = motion.target.z;
    };
  }

  /** @param {RoomRuntime} runtime @param {PublicSnapshot} snapshot @param {boolean} [immediate=false] */
  function applySnapshot(runtime, snapshot, immediate = false) {
    const visualState = runtime.visualState;
    visualState.janela = confirmedValue(snapshot, 'janela');
    visualState.ar = confirmedValue(snapshot, 'ar');
    visualState.ventilador = confirmedValue(snapshot, 'ventilador');
    visualState.umidificador = confirmedValue(snapshot, 'umidificador');
    visualState.lampada = confirmedValue(snapshot, 'lampada');

    const hourValue = environmentValue(snapshot, 'hour');
    const luminosityValue = environmentValue(snapshot, 'luminosity');
    const sleepValue = environmentValue(snapshot, 'sleep');

    if (Number.isFinite(Number(hourValue))) visualState.hour = boundedNumber(hourValue, visualState.hour, 0, 23);
    if (isLuminosity(luminosityValue)) visualState.luminosity = luminosityValue;
    const normalizedSleep = sleepValue === true || sleepValue === 1 || sleepValue === '1'
      ? true
      : sleepValue === false || sleepValue === 0 || sleepValue === '0' ? false : null;
    if (normalizedSleep !== null) visualState.sleep = normalizedSleep;

    const shouldSnap = immediate || runtime.motion.reducedMotion || runtime.motion.requestFrame === null;
    renderAmbient(runtime, runtime.motion.elapsed, 0, shouldSnap);
    if (!renderRuntime(runtime) || shouldSnap) return;
    startMotion(runtime);
  }

  function findFallbackElement() {
    const documentFallback = environment.document?.getElementById?.('room-scene-fallback');
    const containerFallback = fallbackContainer?.querySelector?.('#room-scene-fallback');
    const fallback = documentFallback || containerFallback;
    return fallback && typeof fallback === 'object' ? fallback : null;
  }

  function fallbackChild(fallback, selector) {
    return fallback?.querySelector?.(selector) || null;
  }

  function setStageRendererState(fallback, state) {
    const stage = fallback?.parentElement;
    if (!stage || typeof stage !== 'object') return;
    stage.dataset.rendererState = state;
    stage.setAttribute?.('data-renderer-state', state);
  }

  function setWebGLLoadingState(state, detail = '', progress = null) {
    const fallback = findFallbackElement();
    if (!fallback) return;

    const isUnavailable = state === 'unavailable';
    const title = fallbackChild(fallback, '[data-room-scene-title]');
    const eyebrow = fallbackChild(fallback, '[data-room-scene-eyebrow]');
    const detailElement = fallbackChild(fallback, '[data-room-scene-detail]');
    const message = fallbackChild(fallback, '[data-room-scene-message]');
    const progressBar = fallbackChild(fallback, '[data-room-scene-progressbar]');
    const progressFill = fallbackChild(fallback, '[data-room-scene-progress]');

    fallback.hidden = false;
    fallback.dataset.rendererState = state;
    fallback.setAttribute?.('data-renderer-state', state);
    fallback.setAttribute?.('aria-hidden', state === 'available' ? 'true' : 'false');
    fallback.setAttribute?.('aria-label', isUnavailable ? 'Cena 3D indisponível' : 'Carregando cena 3D');
    fallback.classList?.toggle?.('is-dismissing', state === 'available');
    setStageRendererState(fallback, state === 'available' ? 'ready' : state);

    if (eyebrow) eyebrow.textContent = isUnavailable ? 'CENA 3D INDISPONÍVEL' : 'CENA 3D';
    if (title) title.textContent = isUnavailable ? 'A cena não pôde ser exibida' : 'Preparando o quarto';
    if (detailElement) detailElement.textContent = detail || (isUnavailable
      ? 'A representação estática continua disponível.'
      : 'Carregando modelo e materiais...');
    if (message) message.textContent = isUnavailable
      ? `${detail || 'A cena 3D está indisponível.'} Os controles permanecem utilizáveis.`
      : (detail || 'Carregando a cena 3D. Os controles permanecem utilizáveis.');

    if (!progressBar || !progressFill) return;
    if (Number.isFinite(progress)) {
      const percentage = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      progressBar.setAttribute?.('aria-valuenow', String(percentage));
      progressBar.setAttribute?.('aria-valuetext', `${percentage}% carregado`);
      progressFill.style?.setProperty?.('width', `${percentage}%`);
    } else {
      progressBar.removeAttribute?.('aria-valuenow');
      progressBar.setAttribute?.('aria-valuetext', 'Carregando modelo');
      progressFill.style?.removeProperty?.('width');
    }
  }

  function hideWebGLFallback() {
    const fallback = findFallbackElement();
    if (!fallback) return;
    setWebGLLoadingState('available', 'Cena preparada.');
  }

  function showWebGLFallback(detail = '') {
    setWebGLLoadingState('unavailable', detail);
  }

  function requestNextFrame(runtime, callback) {
    if (runtime.motion.requestFrame) {
      runtime.motion.requestFrame(() => callback());
      return;
    }
    const defer = environment.setTimeout;
    if (typeof defer === 'function') {
      defer(callback, 0);
      return;
    }
    callback();
  }

  function warmUpAndReveal(runtime) {
    if (runtime.disposed || !runtime.modelLoaded) return;

    try {
      runtime.renderer.compile?.(runtime.scene, runtime.camera);
    } catch {
      // A renderer without synchronous compilation can still warm up on render.
    }
    renderAmbient(runtime, runtime.motion.elapsed, 0, true);
    if (!renderRuntime(runtime, true)) {
      showWebGLFallback('O navegador não conseguiu preparar o renderizador WebGL.');
      return;
    }

    requestNextFrame(runtime, () => {
      if (runtime.disposed || !runtime.modelLoaded) return;
      renderAmbient(runtime, runtime.motion.elapsed, 0, true);
      if (!renderRuntime(runtime, true)) {
        showWebGLFallback('O navegador não conseguiu preparar o renderizador WebGL.');
        return;
      }
      runtime.sceneReady = true;
      hideWebGLFallback();
      startMotion(runtime);
    });
  }

  function prepareSceneForReveal(runtime) {
    if (runtime.disposed || !runtime.modelLoaded) return;
    let compilation = null;
    try {
      compilation = typeof runtime.renderer.compileAsync === 'function'
        ? runtime.renderer.compileAsync(runtime.scene, runtime.camera)
        : null;
    } catch {
      compilation = null;
    }
    Promise.resolve(compilation).catch(() => {}).then(() => warmUpAndReveal(runtime));
  }

  /** @param {InitOptions} options @returns {RoomSceneHandle | null} */
  function init(options) {
    if (!options || typeof options !== 'object') throw new TypeError('roomScene.init requires an options object');
    const THREE = options.THREE;
    if (!THREE) throw new TypeError('roomScene.init requires a THREE implementation');
    const container = options.container;
    if (!container) throw new TypeError('roomScene.init requires a container');
    const onDeviceIntent = options.onDeviceIntent;
    if (typeof onDeviceIntent !== 'function') throw new TypeError('roomScene.init requires an onDeviceIntent callback');

    if (activeRuntime) dispose();

    const canvas = container.querySelector?.('canvas') || container;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xb4aba0);

    const aspect = (container.clientWidth || 800) / (container.clientHeight || 600);
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 100);
    camera.position.set(-3.00, 2.10, 2.10);
    camera.lookAt(0.10, 1.55, -0.80);

    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      configureRenderer(THREE, renderer);
    } catch {
      fallbackActive = true;
      showWebGLFallback('WebGL não está disponível neste navegador.');
      return null;
    }
    if (renderer === null) {
      fallbackActive = true;
      showWebGLFallback('WebGL não está disponível neste navegador.');
      return null;
    }
    // Keep the blurred captured scene visible while the GLB is loading and
    // until the first fully warmed frame is ready to be shown.
    setWebGLLoadingState('loading', 'Carregando modelo e materiais...');

    const lights = buildLighting(THREE, scene);
    lights.artificialBounce = new THREE.HemisphereLight(0xffe8c9, 0x6f5035, 0);
    lights.artificialBounce.name = 'light:artificial-bounce';
    scene.add(lights.artificialBounce);
    const { rays: godRayGroup, rayMaterial: godRays } = buildGodRays(THREE, scene);
    const lampLight = createRoomSpotlight(THREE, scene, 'light:ceiling', 0xffeedd, 12, 1.42, 1024);
    const deskLampLight = createRoomSpotlight(THREE, scene, 'light:desk', 0xffddaa, 4, 1.30, 512, 0.68);

    const { mistGroup: humidifierMist, mistMaterial: humidifierMistMaterial, mistState } = buildHumidifierMist(THREE, scene);

    const colorTargets = {
      sun: new THREE.Color(0),
      hemiSky: new THREE.Color(0),
      hemiGround: new THREE.Color(0),
      fill: new THREE.Color(0),
      bounce: new THREE.Color(0),
      background: new THREE.Color(0),
      garden: new THREE.Color(0),
      ray: new THREE.Color(0),
      mist: new THREE.Color(0xffffff),
      lampWarm: new THREE.Color(0xffeedd),
      cove: new THREE.Color(0xffffff),
    };

    const dummyDevice = new THREE.Object3D();
    const devices = {
      janela: dummyDevice,
      ar: dummyDevice,
      ventilador: dummyDevice,
      umidificador: dummyDevice,
      lampada: dummyDevice,
    };

    /** @type {RoomRuntime} */
    const runtime = {
      THREE,
      container,
      onDeviceIntent,
      scene,
      camera,
      renderer,
      devices,
      deviceParts: {
        windowSashes: [null, null],
        acLouver: null,
        acLouverBaseX: null,
        acIndicator: null,
        acGlow: null,
        fanRotor: null,
        fanLampGroup: null,
        humidifierBody: null,
        humidifierMist,
        humidifierMistMaterial,
        mistState,
        garden: null,
        lampMaterial: null,
        lampLight,
        deskLampLight,
        deskLampMaterial: null,
        switchRocker: null,
        godRays,
        godRayGroup,
        soffitLed: null,
        monitorDisplay: null,
        deskLampAlpha: null,
      },
      lights,
      textures: [],
      postprocessing: null,
      ambientOcclusion: { all: [], wardrobe: [], acWall: [], profile: '' },
      motion: {
        reducedMotion: false,
        frame: null,
        lastFrameTime: null,
        elapsed: 0,
        currentWindowAngle: 0,
        fanSpeed: 0,
        currentLouverAngle: 0,
        currentRayOpacity: 0.24,
        currentCoveIntensity: 6.0,
        requestFrame: options.requestAnimationFrame || environment.requestAnimationFrame?.bind(environment) || null,
        cancelFrame: options.cancelAnimationFrame || environment.cancelAnimationFrame?.bind(environment) || null,
        mediaQuery: null,
        mediaChange: null,
      },
      resizeObserver: null,
      resize: () => { },
      handleClick: () => { },
      handlePointerMove: () => { },
      handlePointerLeave: () => { },
      updateHover: () => { },
      clearHover: () => { },
      pointerMoveListener: null,
      pointerLeaveListener: null,
      previousPointerMoveListener: null,
      previousPointerLeaveListener: null,
      cameraMotion: {
        base: { x: -3.00, y: 2.10, z: 2.10 },
        desired: { x: -3.00, y: 2.10, z: 2.10 },
        target: { x: 0.10, y: 1.55, z: -0.80 },
        desiredTarget: { x: 0.10, y: 1.55, z: -0.80 },
        currentTarget: { x: 0.10, y: 1.55, z: -0.80 },
      },
      canvas,
      tooltip: container.querySelector?.('.hover-tooltip') || null,
      hoveredTarget: null,
      interactiveTargets: [],
      colorTargets,
      visualState: {
        hour: SCENE_VISUAL_DEFAULTS.hour,
        luminosity: SCENE_VISUAL_DEFAULTS.luminosity,
        sleep: SCENE_VISUAL_DEFAULTS.sleep,
        janela: SCENE_VISUAL_DEFAULTS.window,
        ar: SCENE_VISUAL_DEFAULTS.ac,
        ventilador: SCENE_VISUAL_DEFAULTS.fan,
        umidificador: SCENE_VISUAL_DEFAULTS.humidifier,
        lampada: SCENE_VISUAL_DEFAULTS.lamp,
      },
      modelRoot: null,
      modelLoaded: false,
      sceneReady: false,
      disposed: false,
      focusedDevice: null,
      detachHoverFocus: null,
      lastPointerEvent: null,
      pointerInsideContainer: false,
    };

    try { runtime.postprocessing = createRoomPostprocessing(THREE, renderer); } catch { /* Direct render fallback. */ }

    runtime.handleClick = createClickHandler(runtime);
    runtime.updateHover = createHoverHandler(runtime);
    runtime.clearHover = () => hideHover(runtime);
    runtime.handlePointerMove = createPointerMoveHandler(runtime);
    runtime.handlePointerLeave = createPointerLeaveHandler(runtime);

    container.addEventListener?.('click', runtime.handleClick);
    container.addEventListener?.('pointermove', runtime.handlePointerMove);
    container.addEventListener?.('pointerleave', runtime.handlePointerLeave);
    runtime.detachHoverFocus = attachDeviceHoverFocus(runtime);

    const resize = () => {
      if (runtime.disposed) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      const aspect = w / h;
      camera.aspect = aspect;
      camera.zoom = aspect < 1.05 ? MOBILE_CAMERA_ZOOM : 1;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    runtime.resize = resize;
    resize();

    const ResizeObserverClass = options.ResizeObserver || environment.ResizeObserver;
    if (ResizeObserverClass) {
      runtime.resizeObserver = new ResizeObserverClass(() => resize());
      runtime.resizeObserver.observe(container);
    }

    activeRuntime = runtime;
    if (typeof window !== 'undefined') {
      window.__roomRuntime = runtime;
      window.__roomRuntime.focusDevice = (device) => focusDevice(runtime, device);
      window.__roomRuntime.clearFocus = () => clearDeviceFocus(runtime);
    }

    // Load Blender GLTF model
    loadRoomModel(runtime, options.modelUrl || '/static/simulador/models/quarto.glb');

    if (options.snapshot) applySnapshot(runtime, options.snapshot, true);

    return {
      scene,
      camera,
      renderer,
      devices,
      focusDevice: (device) => focusDevice(runtime, device),
      clearFocus: () => clearDeviceFocus(runtime),
    };
  }

  /** @param {PublicSnapshot} snapshot */
  function updateSnapshot(snapshot) {
    if (!activeRuntime || activeRuntime.disposed) return;
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('updateSnapshot requires a snapshot');
    if (isErrorSnapshot(snapshot) || !hasSnapshotPayload(snapshot)) return;
    applySnapshot(activeRuntime, snapshot);
  }

  function dispose() {
    if (!activeRuntime) return;
    const runtime = activeRuntime;
    activeRuntime = null;
    runtime.disposed = true;

    cancelMotion(runtime);
    runtime.detachHoverFocus?.();
    runtime.container.removeEventListener?.('click', runtime.handleClick);
    runtime.container.removeEventListener?.('pointermove', runtime.handlePointerMove);
    runtime.container.removeEventListener?.('pointerleave', runtime.handlePointerLeave);
    runtime.resizeObserver?.disconnect();
    runtime.postprocessing?.dispose();

    runtime.scene.traverse?.((child) => {
      child.shadow?.dispose?.();
      child.geometry?.dispose?.();
      const mats = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
      mats.forEach((m) => m?.dispose?.());
    });

    runtime.renderer?.dispose?.();
  }

  const api = Object.freeze({
    init,
    updateSnapshot,
    dispose,
    getActiveRuntime: () => activeRuntime,
    focusDevice: (device) => activeRuntime && focusDevice(activeRuntime, device),
    clearFocus: () => activeRuntime && clearDeviceFocus(activeRuntime),
  });
  globalThis.PEAS = environment.PEAS = environment.PEAS || {};
  globalThis.PEAS.roomScene = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
