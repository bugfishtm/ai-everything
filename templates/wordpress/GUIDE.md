### WordPress

This project is a real WordPress site that the Studio hosts, plus the code you write for it.

- `wordpress/` — the installation (core, `wp-config.php`, uploads, installed plugins and themes).
  **Never edit files in there**: updates replace them and they are not versioned. It appears
  when the user has set WordPress up in the project's **WordPress** tab.
- `plugins/<slug>/` and `themes/<slug>/` — **your own modules**. They are versioned in git and
  linked into `wordpress/wp-content/`, so WordPress runs them directly from here.
- `exports/` — installable zips of the modules, database dumps.

**Start a module** from a starter and adapt it:

```bash
studio wp new plugin my-plugin --name "My Plugin" --template basic      # also: settings | block | rest
studio wp new theme my-theme --name "My Theme" --template block         # also: classic
studio wp link            # only needed after creating a module folder by hand
studio wp status          # is WordPress installed? address, own modules
```

**Work on the site** with WP-CLI inside `wordpress/`:

```bash
cd wordpress
wp plugin activate my-plugin          # wp theme activate my-theme
wp plugin list                        # wp plugin install <name> --activate (from wordpress.org)
wp post create --post_type=page --post_title="Menu" --post_status=publish
wp option update blogdescription "…"
wp eval 'echo my_plugin_function();'  # try code inside WordPress
```

**Check your work** — changes in `plugins/` and `themes/` are live at once:

```bash
studio wp status                                   # shows the internal address
studio-browser shot http://<name>.localhost:8081/ --out .studio/site.png      # then look at the PNG
studio-browser shot "$(studio wp login-url --to /wp-admin/plugins.php)" --out .studio/admin.png
studio wp log                                      # PHP errors (must be empty after your change)
```

`wp config set WP_DEBUG true --raw` (in `wordpress/`) adds notices and warnings to the log —
switch it off again when you are done.

**How to write WordPress code**

- One prefix per module for functions, classes, options, hooks and CSS classes
  (`my_plugin_…`); nothing in the global namespace without it.
- Extend with hooks (`add_action`, `add_filter`) — never change core or other plugins.
- Security on every entry point: escape output (`esc_html`, `esc_attr`, `esc_url`,
  `wp_kses_post`), sanitize input (`sanitize_text_field`, `absint` …), check a nonce and a
  capability on every form, AJAX and REST handler, `$wpdb->prepare()` for SQL.
- Load CSS/JS with `wp_enqueue_style` / `wp_enqueue_script` (with a version), make texts
  translatable (`__( 'Text', 'my-plugin' )`), store settings with the Settings API.
- Clean up: `uninstall.php` removes the module's options and tables.
- Blocks: `block.json` + `register_block_type()`; without a build step the editor script uses
  the `wp.*` globals (see the `block` starter); `edit` and `save` must produce the same markup.
- Themes: block themes are `theme.json` + HTML templates in `templates/` and `parts/`;
  classic themes are PHP templates. A child theme (`Template: parent-slug` in `style.css`)
  changes an existing theme without touching it.
- PHP shell functions (`exec`, `shell_exec` …) are disabled for the site, and it can only reach
  files inside this project. E-mail needs an SMTP plugin (there is no local mail server).

**Deliverables** — `studio wp export my-plugin` writes `exports/my-plugin-<version>.zip` (the
folder `my-plugin/` inside), ready for *Plugins → Add New → Upload* on any WordPress. Keep the
`Version:` header (and `Stable tag` in `readme.txt`) in step with the project's version.

**The user** opens the site and the admin area, installs plugins and themes, updates WordPress
and exports the database in the **WordPress** tab; domains and HTTPS are in the **Website** tab.
