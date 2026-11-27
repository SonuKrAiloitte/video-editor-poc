# CEO demo script (about 12 minutes)

Shows every v1 row of the one-page requirements working, then why the stack differs from the one-pager.

## Before the meeting (10 minutes, once)

```
npm install
npm run media          # sample clips
npm run server         # terminal 1: render server, :5181
npm run dev            # terminal 2: app, :5180
```

1. Open `http://localhost:5180` in **Chrome**. It opens on the **Easy editor**.
2. Click **New post**, then **or try the sample post**. You should see 3 clips with thumbnails, a title, a logo and music.
3. Do one export as a warm-up (**Export**, then **Export video**), so the first export in the room is not the first of the day.
4. Have one real phone video (under 1 minute) and one PNG logo ready in Finder.
5. Close other heavy tabs. Optional: run `npm run ui-check` to confirm everything works (about 5 minutes).

## The walkthrough (Easy editor)

Everything is a click; no keyboard shortcuts needed. The bottom toolbar changes with what you select, and **Done** always goes back.

| # | Say | Do | Requirement row |
|---|---|---|---|
| 1 | "This is the editor someone in marketing would use." | Start from the sample. Click the video to play; scroll the timeline to move through it. | Preview |
| 2 | "Uploading your own footage: MP4, MOV or WebM." | **Add video**, then **Upload a video from your computer**, pick the phone video. It lands at the end, selected. | Import |
| 3 | "Or pick from the platform library." | **Done**, then **Music**: pick `music.mp3` under **Samples**. It starts at the playhead. | Import |
| 3b | "A story can be just photos." | **Add video**, upload a photo. It becomes a 5-second clip; **Length** sets 2 to 10 seconds. | Import (images) |
| 4 | "Trim, split and delete." | Click a clip: drag its white handles to trim. Move the playhead into it, **Split**. Click one half, **Delete**. | Trim, split, delete |
| 5 | "Reorder by dragging." | Drag a clip card left or right. | Merge and reorder |
| 6 | "Titles with font, size, colour and position." | **Text**, type a title (Enter for a second line), **Done**. **Font**: Bebas Neue. **Size**: drag the slider. **Position**: Bottom, or drag the title on the video. | Text and captions |
| 6b | "And the Instagram look." | **Style**: **Solid**, then a box colour (the text turns black or white to stay readable), **See-through**; **Left** / **Right**; **Outline**, then **Neon**. | Text and captions |
| 7 | "A logo or watermark." | **Logo**, upload the PNG. **Position**: Top right. **Size**: drag the slider. Drag the orange bar's ends to show it for only part of the video. | Image overlay |
| 8 | "Sound, and only the part of the song you want." | Click a clip, **Mute**. Click a green music bar: drag its handles to keep part of the song, drag the bar to move it, **Split** at the playhead, **Volume** for that piece. Add a second song with the small music **+**. | Audio |
| 9 | "Same edit for Reels, YouTube or a square post." | Click the format chip at the top: **YouTube**, then **Square**, then back to **Reel / Story**. | Aspect ratio |
| 10 | "Mistakes are cheap." | The **undo** arrow a few times, **redo** back. | Undo, redo |
| 11 | "Work is saved as you go." | Reload the page. Everything, including the uploaded video, comes back. | Autosave, reopen draft |
| 12 | "Export." | **Export**, choose **High (1080p)**, **Export video**. Play it in the panel. | Export |
| 13 | "And it goes back into the library." | **Save to my media**. Then **Add video**: it is listed under **Your saved videos**. | Export: save to library |
| 14 | "For the technical comparison." | In the export panel, **Technical details**: switch to **Browser (Mediabunny)** and export again. | (optional engine from the one-pager) |

If someone asks for more control, open **Advanced editor** (top bar): the same post, with number fields, a full timeline and all three export engines side by side.

## Why the stack differs from the one-pager (2 minutes)

The one-pager recommended Twick as the editor base and asked for a short spike first: "embed Twick, run one edit end to end, and confirm export quality". We did exactly that, and Twick did not pass:

- Its browser export **failed on WebM** and **hung on an iPhone-style HEVC MOV**.
- It was **about 10x slower** to export (32 to 48 s for a 7 s edit, against 1 to 3 s on our server path).
- Its server render needs headless Chrome, not plain FFmpeg, and it has had **no release since May 2026**.

So we kept the parts of the one-pager that worked (**FFmpeg on the server** as the default export, **Mediabunny** as the fast browser option) and replaced Twick with a small editor core of our own (about 1,450 lines including the render server). The hard parts (decoding, encoding, mixing) are still open source. It also removes the Twick licence sign-off from the decision list.

If asked to see it: the **Comparison only: Twick** link (top right) opens Twick as shipped. The README has steps to reproduce its WebM failure.

## Numbers to quote

| Export engine (10 s vertical edit) | 720p | 1080p |
|---|---|---|
| FFmpeg on the server (this Mac) | 0.7 to 0.8 s | 1.2 s |
| FFmpeg on the server (Windows laptop) | 1.7 to 2.9 s | 2.7 to 3.7 s |
| Mediabunny, in the browser (Windows laptop) | 4.1 to 4.7 s | 4.7 to 5.6 s |
| ffmpeg.wasm, in the browser (Windows laptop) | 15 to 17 s | 31 s |
| Twick browser export | 32 to 48 s for a 7 s edit; WebM fails | not run |

The three own-core engines produce matching output: frame similarity against the server render is 0.99 (ffmpeg.wasm) and 0.97 (Mediabunny), and sound levels agree within 0.1 dB.

## Be ready for these questions

- **"Is this production-ready?"** No. It's a proof of concept. Production needs login, cloud storage (S3 or equivalent) instead of local folders, a render queue, and input validation on the render API.
- **"Which browsers?"** Tested in Chrome only. Safari, Firefox and mobile are untested; the server export does not depend on the browser.
- **"How long can videos be?"** Only short edits (under 20 s) have been measured. Long videos should use the server export; the browser exports keep everything in memory. Maximum length is one of the open decisions.
- **"Can titles be in Hindi?"** Not tested yet. It needs a Devanagari font and a check that the FFmpeg build shapes the text correctly.
- **"Licensing?"** All five fonts are SIL Open Font Licence. The FFmpeg build used here is GPL. Which build to ship (GPL or LGPL) is an open decision.

Still open from the one-pager's decision list: maximum length and file size, browsers and mobile, where files are stored, and whether 1080p is enough (1080p works today).

## If something goes wrong

- **Uploads say they "couldn't be saved to My media"**: the render server is not running. Start `npm run server` and add the file again.
- **An imported video is refused** ("this browser cannot decode..."): it's an HEVC file this Chrome can't play. Server export can still read it. Use an MP4 for the demo.
- **The preview is black after a reload**: the draft pointed at a file from before uploads were saved; a notice says so. Re-import the file.
- **Anything else**: **New post**, then **or try the sample post**, and carry on from step 4.
