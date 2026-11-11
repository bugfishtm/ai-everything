### Video — with studio-video and studio-stickman

**Timelines** (trailers, slideshows, shorts, explainers, montages) — use `studio-video`: the video
is a text file `src/<name>.video.yaml` — clips one after another (video files, pictures with zoom
and pan, title cards, stick scenes, studio-image pictures), transitions, text overlays, subtitles
and a mixed soundtrack — rendered to `exports/<name>.mp4`. **Read the reference once: `studio-video docs`.**
- Know the material first: `studio-video probe <file>` (length, size, sound) and
  `studio-video frames <file>` (a contact sheet of what the footage shows, with times).
- `studio-video new src/<name>.video.yaml --template trailer|slideshow|social|blank`, then edit.
- Look before you render: `studio-video sheet src/<name>.video.yaml` and read the PNG;
  `studio-video info …` prints every time; `render … --draft` is the fast test, `render … --preview` the final.
- Sound: `audio:` takes files, studio-daw songs (`song: src/x.song.yaml`, rendered for you) and
  effects (`sfx: swoosh`); `duck: 8` keeps music under the clips' own sound.
- Title art, thumbnails and logos: `studio-image` (`picture: src/x.image.yaml` puts one in a clip).
- The user can run Check / Draft / Render on the file in the Files tab.

**Stick figure animation** (fights, sketches, explainers, dances, music videos) — use
`studio-stickman`: the scene is a text file `src/<name>.stick.yaml` (figures, poses and actions
on a timeline, props, camera, words, sound effects), rendered to `exports/<name>.mp4`.
- `studio-stickman new src/<name>.stick.yaml --template fight|talk|dance|blank`, then edit the file.
- Look before you render: `studio-stickman sheet src/<name>.stick.yaml` and read the contact sheet
  PNG; `studio-stickman render … --draft` for a fast test, `render … --preview` for the final.
- Music: make it with `studio-daw` (`exports/<song>.mp3`), set `scene.audio` and `scene.bpm` —
  then moves can sit on beats (`t: "5:1"`). The user can run Check / Draft / Render in the Files tab.
- Missing a move, prop or place? Add it: `studio-stickman plugin new <name> --kind action|pose|prop|fx|backdrop|sound`.
- Full reference: `studio-stickman docs`.

**Anything else** (screen recordings, special effects, formats the tools do not cover): ffmpeg
directly — `ffmpeg -y -framerate 30 -i .studio/frames/%05d.png -c:v libx264 -pix_fmt yuv420p -crf 20
exports/out.mp4`, always `-pix_fmt yuv420p` and even sizes; or a generator plugin for studio-video
(`studio-video plugin new <name> --kind generator`: Python draws every frame).

**Check your work** — contact sheets (`studio-video sheet`, `studio-video frames exports/out.mp4`)
and `studio-video probe` for length, size and sound. Never say a video is done without having
looked at its frames.

**Deliverables** — MP4 (H.264 + AAC) in `exports/` (+ `.srt` for subtitles); sources stay in `src/`.
