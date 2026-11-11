---
name: publish-website
title: Put a project online
description: Use when the user wants a website, web app or game to go live, be reachable under their own domain, get HTTPS, or asks why a published site or its certificate does not work.
areas: [web, game]
---

# Put a project online

The Studio serves published projects as real websites. Publishing copies a snapshot — the
live site only changes when you publish again.

## 1. Before publishing

- All URLs relative (`./assets/x.png`, not `/assets/x.png`) unless the site is served from the root
  of its own domain anyway; no `localhost` addresses in the code.
- `studio-browser console index.html` shows no errors; the page has a `<title>`, a description
  meta tag, a favicon and `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Build tools: the build must work from a clean checkout (`npm ci && npm run build`).

## 2. Publish

```bash
studio site publish                                        # plain files from the project root
studio site publish --root dist --build "npm run build"    # with a build step
studio site publish --root dist --build "npm run build" --spa    # single-page app: unknown paths → index.html
studio site status                                         # addresses, last publish, settings
```

A project server (`studio service deploy`) shares the origin of the website:
`fetch("/srv/<server>/api/…")` works without CORS.

## 3. Domains

```bash
studio site domain add example.com www.example.com
studio site domain check          # does DNS point here?
```

Tell the user exactly which DNS records to create at their registrar: an A record (and AAAA
for IPv6) per domain pointing at the public IP of this server. `check` shows where each domain
points right now. DNS changes can take from minutes to a few hours.

## 4. HTTPS

```bash
studio site cert                  # certificate of every domain: issuer, days left, errors
studio site cert issue            # request / renew now
```

- Certificates are issued automatically (Let's Encrypt) once the domain points here and ports
  80 and 443 of the server reach the Studio. The first one takes about a minute.
- Typical errors: DNS not pointing here yet (wait, check again) · port 80 not reachable from
  the internet (router / firewall — the user or admin must open it) · too many requests (the
  Studio retries by itself with growing pauses — do not hammer `issue`).
- The user can upload their own certificate or switch a domain to "self-signed" / "off" in
  the project's **Website** tab; an admin sets the contact e-mail for Let's Encrypt under Admin → HTTPS.

## 5. Report

Give the user the live addresses, what is published (root, build command) and anything they
still have to do (DNS records, open ports). After later changes: `studio site publish` again.
