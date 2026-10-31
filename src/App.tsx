import { useEffect, useState } from 'react';
import { AssetsPage } from './components/AssetsPage';
import { Editor } from './components/Editor';
import { Home } from './components/Home';
import { ToastHost } from './components/ui';

type Route = { name: 'home' } | { name: 'assets' } | { name: 'editor'; id: string };

function readRoute(): Route {
  const match = window.location.hash.match(/^#\/deck\/([\w-]+)/);
  if (match) return { name: 'editor', id: match[1] };
  if (/^#\/assets/.test(window.location.hash)) return { name: 'assets' };
  return { name: 'home' };
}

function navigate(hash: string) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      {route.name === 'home' ? (
        <Home onOpen={(id) => navigate(`#/deck/${id}`)} onOpenAssets={() => navigate('#/assets')} />
      ) : route.name === 'assets' ? (
        <AssetsPage onBack={() => navigate('#/')} />
      ) : (
        <Editor key={route.id} deckId={route.id} onBack={() => navigate('#/')} />
      )}
      <ToastHost />
    </>
  );
}
