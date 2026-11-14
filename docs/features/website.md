# Player website and wiki (`docs/`, `scripts/tools/build-docs.py`)

The player website (GitHub Pages, served from Live's `master` `/docs`) and the wiki. How to update and publish them: `docs/dev/publishing-guide.md`.
- **Generated pages:** `build-docs.py` writes every `.html` page of `docs/` and `docs/wiki/`, `docs/wiki-source/`, `docs/FEATURES.md` and `docs/FEATURE-AUDIT.md` from `docs/data/` (`feature-catalogue.json`, `changelog.json`, `guides/`). Page text that isn't in the data (page intros, headings) is in the generator.
- **Hand-written files:** `docs/css/original.css` (the original website's style), `docs/css/guide.css` (the adaptations), `docs/js/guide.js` (features page) and `docs/js/changelog.js` (changelog page). A change there reaches the published pages without regenerating them.
- **Category ids name the pages** (`wiki/<id>.html`, `Features-<id>.md`) and the features page's `?category=` filter: a category's title can change, its id can't without breaking links.
- **Every page works without JavaScript**: everything is shown, only search and folding need it. `guide.js` runs on every page and stops at once without the features page's search form.

## Features page (`features.html`, `guide.js`)
- **Search** matches every word typed against the whole text of an entry (details included); **Category** shows one category. A category with no match is hidden. Both are kept in the address (`?q=`, `?category=`) so a filtered page can be shared.
- **Categories start folded.** The script turns each category title into a toggle (`<button aria-expanded>` inside the `<h2>`, a triangle on its left that turns in place) followed by the number of features in grey (the number of matches during a search). A folded category shows only its title. Not `<details>` in the generator: the heading would lose its heading role for screen readers, and the filter would have to open them anyway.
- **Fold all / Unfold all** next to Reset acts on the categories shown; its label says what a click does and its width doesn't change with it.
- **A search or a category choice unfolds everything**, folds included that the address brought in at load; once both are cleared, the folds from before come back. Folds made during the search are dropped then.
- **Folds are not remembered** across visits: a returning visitor seeing empty categories would think features were missing.
- **A link to a feature** (`#<feature id>`, the title's link) clears a filter that hides it, unfolds its category, opens its details and scrolls to it.
- **Printing shows every category in full**, folded or not, without the triangles.
- Limits: the browser's find (Ctrl+F) doesn't search folded categories (`hidden="until-found"` would clash with the `hidden` the filter sets). On a slow first visit, the full list may show for a moment before the script folds it.
