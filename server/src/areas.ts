/**
 * Workspace areas. Each area has a project template in templates/<id>/ and
 * a guide that is merged into the project's CLAUDE.md.
 */
export interface Area {
  id: string;
  name: string;
  tagline: string;
  description: string;
  color: string;
  icon: string;
  /** default file the Preview tab opens (web based areas) */
  previewPath?: string;
  /** asset kinds this area produces / consumes most */
  kinds: string[];
  /** pack types (packs/README.md) that matter most here */
  packTypes: string[];
  /** apps of this area often need a backend (multiplayer, storage …): offer Node.js servers */
  services?: boolean;
  /** results are web pages: offer publishing them as a website (sites.ts) */
  sites?: boolean;
  /** projects are WordPress sites (wordpress.ts): the WordPress tab */
  wordpress?: boolean;
  /** software that gets version numbers: "Versioning" is preselected for new projects */
  versioning?: boolean;
  starters: string[];
}

export const AREAS: Area[] = [
  {
    id: 'music',
    name: 'Music',
    tagline: 'Compose, arrange and render music from text',
    description:
      'Songs are written as text (score/arrangement files, MIDI generators) and rendered to MIDI, WAV and MP3 with FluidSynth and ffmpeg.',
    color: '#f472b6',
    icon: 'music',
    kinds: ['music', 'audio'],
    packTypes: ['music'],
    starters: [
      'Compose a calm 60-second lo-fi loop (piano, bass, drums) and render it to exports/ as WAV and MP3.',
      'Write a short heroic theme for a video game boss fight and render a MIDI and a WAV.',
      'Create 5 short UI sound effects (click, confirm, error, coin, level-up) as WAV files.',
    ],
  },
  {
    id: 'image',
    name: 'Image',
    tagline: 'Posters, icons, textures and sprites',
    description:
      'Pictures are written as text — layers of shapes, text, textures and pixel art — and rendered to PNG, JPG, WebP or ICO with Studio Image. Existing images can be analysed, converted and combined.',
    color: '#fb923c',
    icon: 'image',
    kinds: ['image'],
    packTypes: ['image'],
    starters: [
      'Design a flat app icon of a fox and export it as PNG in 512, 192 and 48 px plus a favicon.',
      'Make a poster for a synthwave concert: a sunset, a grid floor, a big title and the date.',
      'Create a seamless 512×512 stone wall texture and a matching mossy version.',
      'Draw a 4-frame pixel-art walk cycle sprite sheet for a small robot.',
    ],
  },
  {
    id: 'model3d',
    name: '3D Models',
    tagline: 'Models, props and scenes for games and more',
    description:
      'Models are scenes written as text (shapes, materials, textures) and built to .glb — the AI writes them, and you can change them by hand in the 3D editor right here.',
    color: '#60a5fa',
    icon: 'box',
    kinds: ['model3d'],
    packTypes: ['3d'],
    starters: [
      'Build a low-poly pine tree as a .glb with two materials (trunk and leaves).',
      'Model a simple wooden treasure chest with an openable lid as a separate node.',
      'Create a modular dungeon kit: floor tile, wall, corner and door frame (.glb each).',
    ],
  },
  {
    id: 'video',
    name: 'Video',
    tagline: 'Animations, edits and motion graphics',
    description:
      'Videos are text timelines: clips, pictures, title cards, transitions, overlays, subtitles and a mixed soundtrack, rendered to MP4 with Studio Video. Stick figure animations are written as text scenes (Studio Stickman) and fit right into a timeline.',
    color: '#f87171',
    icon: 'clapperboard',
    kinds: ['video', 'audio', 'image'],
    packTypes: ['video', 'music', 'image'],
    starters: [
      'Animate a stick figure fight in a dojo: two fighters, a combo, a block and a knockout — with sound effects.',
      'Make a short stick figure sketch: two characters talk at a desk and one of them delivers a punchline.',
      'Make a 20-second trailer: a title card, three scenes with captions, an end card, music and sound effects.',
      'Turn the images in assets/ into a slideshow video with slow zooms, crossfades and background music.',
      'Make a vertical 15-second short with big text, subtitles and a beat.',
    ],
  },
  {
    id: 'game',
    services: true,
    versioning: true,
    sites: true,
    name: 'JS Games',
    tagline: 'Browser games you can play instantly',
    description:
      'HTML5/JavaScript games (canvas, WebGL, three.js, Phaser …). Press Play to run the game in a sandboxed preview.',
    color: '#a3e635',
    icon: 'gamepad',
    previewPath: 'index.html',
    kinds: ['model3d', 'image', 'audio', 'music'],
    packTypes: ['3d', 'music', 'image'],
    starters: [
      'Make a polished Snake game with a start screen, score, high score and sound effects.',
      'Create a small 3D endless runner with three.js (no build step) and keyboard controls.',
      'Build a platformer level with a player, coins, enemies and a goal flag.',
      'Make a small online multiplayer game: players move in a shared arena via a Node.js WebSocket server.',
    ],
  },
  {
    id: 'android',
    services: true,
    versioning: true,
    name: 'Android Apps',
    tagline: 'Kotlin apps built into installable APKs',
    description:
      'Native Android apps with Kotlin, Jetpack Compose and Gradle. Debug APKs land in exports/ for download.',
    color: '#34d399',
    icon: 'smartphone',
    kinds: ['image', 'audio'],
    packTypes: ['image'],
    starters: [
      'Create a Jetpack Compose to-do app with persistence and build a debug APK into exports/.',
      'Make a simple Android tally counter app with haptic feedback and dark mode.',
      'Build an Android quiz app with an online leaderboard stored on a Node.js server.',
    ],
  },
  {
    id: 'windows',
    services: true,
    versioning: true,
    name: 'Windows Software',
    tagline: '.exe programs and installers',
    description:
      'Windows programs with .NET (console, WinForms, WPF) or C/C++ via mingw-w64, cross-compiled to .exe in exports/.',
    color: '#38bdf8',
    icon: 'monitor',
    kinds: ['image'],
    packTypes: [],
    starters: [
      'Write a WinForms app that renames files in bulk with a preview list, published as a single .exe.',
      'Make a tiny C program that shows a Windows message box, compiled with mingw-w64.',
    ],
  },
  {
    id: 'web',
    services: true,
    versioning: true,
    sites: true,
    name: 'Web Apps',
    tagline: 'Websites, tools and prototypes',
    description: 'Static sites and web apps (HTML/CSS/JS or Vite builds) with a live sandboxed preview.',
    color: '#c084fc',
    icon: 'globe',
    previewPath: 'index.html',
    kinds: ['image', 'code'],
    packTypes: ['image'],
    starters: [
      'Build a landing page for a fictional coffee roastery with a menu and contact form.',
      'Make a Pomodoro timer web app with settings and notifications.',
    ],
  },
  {
    id: 'wordpress',
    sites: true,
    wordpress: true,
    versioning: true,
    name: 'WordPress',
    tagline: 'Sites, plugins, themes and blocks',
    description:
      'A real WordPress site per project — installed with a click, with its own database and address. The AI builds plugins, themes and blocks for it; you manage everything in the WordPress tab and export installable zips.',
    color: '#3b82f6',
    icon: 'blocks',
    kinds: ['image', 'code'],
    packTypes: ['image'],
    starters: [
      'Build a plugin that adds a contact form shortcode with spam protection and stores the messages in the admin area.',
      'Create a block theme for a small bakery: warm colours, a hero section, a menu page and an opening-hours footer.',
      'Write a Gutenberg block that shows a pricing table with three plans and editable features.',
      'Make a plugin with a custom post type "Events" (date, place), an archive page and a REST endpoint for upcoming events.',
    ],
  },
  {
    id: 'general',
    services: true,
    sites: true,
    name: 'Anything Else',
    tagline: 'Scripts, tools, research, documents',
    description: 'A blank workspace with every tool in the image available.',
    color: '#94a3b8',
    icon: 'sparkles',
    kinds: [],
    packTypes: [],
    starters: ['Write a Python script that organises my photos in assets/ by date.'],
  },
];

/**
 * The Chat page: plain conversations with Claude. Each user has one hidden
 * project of this area that holds their chats (and uploaded attachments).
 * It is not listed among the areas and projects.
 */
export const CHAT_AREA: Area = {
  id: 'chat',
  name: 'Chat',
  tagline: 'Talk with Claude about anything',
  description: 'Casual conversations — questions, ideas, explanations, writing help. Claude can read attachments and search the web.',
  color: '#a78bfa',
  icon: 'message',
  kinds: [],
  packTypes: [],
  starters: [
    'Explain how a synthesizer filter shapes a sound, in simple words.',
    'Give me 10 ideas for a small cozy game I could build in a weekend.',
    'Help me write a friendly product description for a hand-made wooden toy.',
  ],
};

export function getArea(id: string): Area | undefined {
  return id === CHAT_AREA.id ? CHAT_AREA : AREAS.find((a) => a.id === id);
}
