import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

export default function Room({ url = '/models/room.glb' }) {
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => {
    const s = scene.clone(true);
    s.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.material) {
          o.material.envMapIntensity = 1.0;
          if (o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
        }
      }
    });
    return s;
  }, [scene]);
  return <primitive object={cloned} />;
}

useGLTF.preload('/models/room.glb');
