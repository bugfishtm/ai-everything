---
name: wordpress-module
title: Build a WordPress plugin, theme or block
description: Use when the user wants a WordPress plugin, theme, child theme, Gutenberg block, shortcode, custom post type, settings page, REST endpoint or WooCommerce extension built or changed — from the starter to a tested, installable zip.
areas: [wordpress]
---

# Build a WordPress plugin, theme or block

Own code lives in `plugins/<slug>/` and `themes/<slug>/` of the project (never in `wordpress/`).

## 1. Start

```bash
studio wp status                       # WordPress installed? address, own modules
studio wp new plugin <slug> --name "…" --template basic|settings|block|rest
studio wp new theme <slug> --name "…" --template block|classic
```

Not installed yet → ask the user to set WordPress up in the **WordPress** tab (title, admin
account); you can already write the module meanwhile.

Pick the starter by what is asked: a shortcode or hook → `basic`; options an admin changes →
`settings`; something authors place in the editor → `block`; structured content (events,
recipes, products) or data for apps → `rest`. A design for the whole site → theme `block`
(or `classic` when the user wants PHP templates).

## 2. Write it

- Read the starter first, then change it — keep its structure (header comment, prefix, hooks).
- Prefix everything with the module's prefix. Escape on output, sanitize on input, nonce +
  capability check on every form / AJAX / REST handler, `$wpdb->prepare()` for SQL.
- Data: options for settings (`register_setting`), post meta for per-post data, a custom post
  type for content, an own table (`dbDelta` on activation) only for large or relational data.
- Front end: enqueue assets only where they are needed; no inline `<script>` with user data
  (`wp_add_inline_script` / `wp_localize_script` instead).
- Blocks: attributes in `block.json`; `edit` and `save` must match; dynamic content →
  `"render": "file:./render.php"` instead of `save`. Raise the version in `index.asset.php`
  when the script changes.
- Themes: colours, fonts and spacing belong in `theme.json`; templates in `templates/*.html`,
  shared pieces in `parts/*.html`.

## 3. Activate and test — every time

```bash
cd wordpress
wp plugin activate <slug>              # or: wp theme activate <slug>
cd .. && studio wp log                 # must show no new PHP errors
studio-browser shot http://<name>.localhost:8081/<page>/ --out .studio/front.png
studio-browser shot "$(studio wp login-url --to /wp-admin/<screen>)" --out .studio/admin.png
```

Look at both screenshots. Create test content with WP-CLI (`wp post create …`, a page with the
shortcode or block markup) so there is something to see. Test the unhappy paths: empty input,
wrong nonce, a visitor who is not signed in (`curl -s -X POST …` must be refused).
REST: `curl -s -H "Host: <name>.localhost" http://127.0.0.1:8081/wp-json/<slug>/v1/…`.

## 4. Hand over

```bash
studio wp export <slug>                # → exports/<slug>-<version>.zip (installable anywhere)
```

Update the `Version:` header, `Stable tag` and the changelog in `readme.txt` (and CHANGELOG.md
when the project is versioned) before exporting. Tell the user: what the module does, where to
find it in the admin area, how to use it (shortcode, block name, settings page), and the zip.

## Never

- Edit WordPress core, installed plugins or themes — use hooks, or a child theme.
- Store secrets in the code — use options or constants in `wp-config.php`.
- Use `exec`, `shell_exec`, `eval`, or load remote code.
- Leave `WP_DEBUG` on, or test content the user did not ask for, on a site that is public.
