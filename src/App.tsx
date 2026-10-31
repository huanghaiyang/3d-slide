import { useEffect, useState } from 'react';
import { Editor } from './components/Editor';
import { Home } from './components/Home';
import { ToastHost } from './components/ui';

type Route = { name: 'home' } | { name: 'editor'; id: string };

function readRoute(): Route {
  const match = window.location.hash.match(/^#\/deck\/([\w-]+)/);
  if (match) return { name: 'editor', id: match[1] };
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
        <Home onOpen={(id) => navigate(`#/deck/${id}`)} />
      ) : (
        <Editor key={route.id} deckId={route.id} onBack={() => navigate('#/')} />
      )}
      <ToastHost />
    </>
  );
}
