import { Canvas } from '@react-three/fiber';
import { CameraControls, Environment } from '@react-three/drei';
import { Suspense, useRef, useState } from 'react';
import * as THREE from 'three';
import Room from './Room.jsx';
import SceneryPicker from './SceneryPicker.jsx';
import { SCENERY } from './scenery.js';

// Coordinate note: Blender Z-up exports to Three.js Y-up via export_yup=True.
// So Blender (X, Y, Z) → Three.js (X, Z, -Y).

const HERO_POS    = [2.4, 1.55, -1.8];
const HERO_TARGET = [0, 1.0, 1.6];
const SIT_POS     = [0, 1.4, -0.2];
const SIT_TARGET  = [0, 1.0, 1.6];

export default function DeskScene() {
  const ccRef = useRef(null);
  const [scenery, setScenery] = useState(SCENERY[0]);

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}>
      <Canvas
        shadows
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        dpr={[1, 2]}
        frameloop="always"
        camera={{ position: HERO_POS, fov: 35, near: 0.05, far: 100 }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
      >
        <Suspense fallback={null}>
          <Environment files={scenery.hdri} background />
          <Room />
        </Suspense>

        <ambientLight intensity={0.25} />
        <directionalLight
          position={[2, 4, -3]}
          intensity={1.6}
          color="#ffb070"
          castShadow
          shadow-mapSize={[1024, 1024]}
        />

        <CameraControls
          ref={ccRef}
          makeDefault
          minDistance={0.4}
          maxDistance={8}
          target={HERO_TARGET}
        />
      </Canvas>

      <SceneryPicker
        current={scenery}
        onChange={setScenery}
        onSitDown={() => ccRef.current?.setLookAt(...SIT_POS, ...SIT_TARGET, true)}
        onLookAround={() => ccRef.current?.setLookAt(...HERO_POS, ...HERO_TARGET, true)}
      />
    </div>
  );
}
