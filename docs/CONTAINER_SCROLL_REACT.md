# Animation ContainerScroll (Taply)

## Architecture

Le site public Taply est toujours **statique** (HTML/CSS/JS). L'îlot React est limité à la présentation du dashboard dans `index.html`, sans migration vers Next.js, sans serveur React et sans changement des API.

- **`components/ui/container-scroll-animation.tsx`** : composant React inspiré d'Aceternity ContainerScroll, Framer Motion `useScroll`/`useTransform`, inclinaison + zoom liés au défilement.
- **`components/ui/demo.tsx`** : exemple Taply avec la capture réelle du dashboard existant (`images/dashboard-real-demo-preview.png`).
- **`components/dashboard-scroll.tsx`** : point de montage React sur `[data-dashboard-react-root]`.
- **`js/dashboard-scroll-loader.js`** : charge le bundle différé à proximité du viewport ; une capture statique reste visible si JS est désactivé ou échoue.
- **`styles/dashboard-scroll.tailwind.css`** : Tailwind 4 limité aux utilitaires utilisés, **sans Preflight** pour protéger les styles existants ; CSS compilée dans `dist/css/dashboard-scroll.css`.
- `scripts/build-static.mjs` : copie uniquement les ressources publiques autorisées, compile l'îlot TSX par esbuild en `dist/js/dashboard-scroll-react.js`, sans publication des sources TSX ou des sourcemaps.
- `tsconfig.react.json` : TypeScript/JSX isolé, alias `@/*`. `components.json` : structure préparée pour shadcn.

## Utiliser shadcn/ui plus tard

Le dossier standard est **`/components/ui`**, à conserver car les importations conventionnelles des composants shadcn ciblent `@/components/ui`. La configuration est présente dans `components.json`. Le site n'est pas une application Next.js : n'exécutez pas une migration `shadcn init` sur le projet public sans décision explicite. Pour ajouter d'autres composants shadcn, vérifier les utilitaires CSS et éventuellement créer `lib/utils.ts`, installer `clsx` / `tailwind-merge` et utiliser `npx shadcn@latest add ...` dans une branche dédiée.

Les icônes marketing restent les SVG existants de Taply ; aucun `lucide-react` ou stock Unsplash n'est nécessaire pour ce composant.

## Tests et sécurité

`npm run check`, `npm run build:static` et `TAPLY_TEST_SITE_URL=http://127.0.0.1:PORT npx playwright test -c tests/visual/playwright.config.ts dashboard-story.spec.ts`.

La capture est **illustrative** : les nombres affichés dans le dashboard de démonstration ne doivent pas être présentés comme des résultats réels de clients.
