# Clip Marker

Clip Marker is a web app that saves a marker when you press a button during a stream. Each marker has the
time into the stream and a category, for example "Good save". The app posts nothing to YouTube and needs
no Google account. A different tool can read the marker file later and cut the clips.

## Start the app

1. Run `node server.js` in this folder. Node 18 or later is necessary. There are no packages to install.
2. Open `http://<address of the Pi>:8095` on the laptop or the phone.
3. To use a different port, set `PORT`, for example `PORT=9000 node server.js`.

## The service on the Pi

- The systemd user unit `clip-marker.service` runs the app on port 8095. The copy is `systemd/clip-marker.service`.
- To restart it after a code change, run `systemctl --user restart clip-marker.service`.
- The Pi dashboard lists the app as "Clip Marker" (`~/projects/rpi-dashboard/apps.json`).
- The Cloudflare route is `clips.arorashivoy.win` in `~/.cloudflared/rpi-dashboard.yml`. The app has no
  login, so the hostname must have a Cloudflare Access application before it gets a DNS record.

## Use the app

1. Select the game.
2. Start the stream on YouTube. Paste the link of the stream and select Start.
3. Press a button on the screen, or press the key that the button shows.
4. To add a button to the game, select "+ Add a button" after the last button. Give the name and the key.
5. If a press was a mistake, delete the marker in the list.
6. Select Stop when the stream ends. Then download the marker file with the JSON or CSV link.

The app reads the start time of the stream from the public YouTube page. If it cannot read the start time,
or if you give no link, the clock starts when you select Start. A message tells you when this occurs.

## Start and end of a long event

Each game has one range button, for example "Boss fight" for Elden Ring. The key is `1`.

1. Press the range button when the event starts. The button shows "End" and the time since the start.
2. Press the other buttons as usual during the event, for example "Close call". They do not change the range.
3. Press the range button again when the event ends.

- If you select Stop while a range is open, the app saves the end marker at that moment.
- If you delete the end marker in the list, the range is open again. If you delete the start marker, the app
  also deletes the end marker.
- To make a different button a range button, open Settings and select "Start/End" on the row of the button.

The keys work only when the page has the focus and the cursor is not in a text box.

## The marker file

Download the markers of a session as JSON or CSV. The links are below the buttons, and Settings has the
files of all sessions. The JSON file has this structure:

```json
{
  "sessionId": "dQw4w9WgXcQ",
  "videoId": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Elden Ring, first run",
  "ranges": [
    {
      "id": "32232d60ab",
      "game": "Elden Ring",
      "category": "Boss fight",
      "offsetFrom": "stream",
      "startAt": "2026-11-15T14:20:02.120Z",
      "startSec": 2990,
      "start": "0:49:50",
      "endAt": "2026-11-15T14:33:40.871Z",
      "endSec": 3808,
      "end": "1:03:28",
      "durationSec": 818
    }
  ],
  "markers": [
    {
      "id": "3f9a1c2b7d",
      "at": "2026-11-15T14:32:17.561Z",
      "game": "Elden Ring",
      "category": "Boss down",
      "offsetSec": 3725,
      "offset": "1:02:05",
      "offsetFrom": "stream"
    }
  ]
}
```

- `offsetSec` is the time into the stream, in seconds. Use it to cut the YouTube recording.
- `at` is the time of day in UTC. Use it to cut a local recording, for example from OBS: subtract the
  start time of the recording file.
- `offsetFrom` is `stream` when the clock comes from the start time of the stream. It is `connect` when
  the clock started at the press of Start.
- The marker is the moment of the press, which is usually a few seconds after the action. Start each clip
  before the marker.

- `ranges` has one entry for each press pair of a range button. `endSec` is `null` while the range is open.
  `markers` has only the markers of the other buttons.
- In the CSV file, the column `kind` is `marker`, `start` or `end`. The column `range_id` joins a start to its end.

`data/markers.jsonl` on the Pi holds all markers, one JSON line for each marker.

## Cut the clips with yt-dlp (optional)

`clip.js` cuts one clip for each marker with yt-dlp (https://github.com/yt-dlp/yt-dlp) and ffmpeg.

1. Wait until YouTube finishes the recording of the stream.
2. Run `node clip.js <link of the stream>`. The clips go to the folder `clips`.
3. To change the length, use `--before 30` and `--after 15` (seconds). To see the commands only, add `--dry`.

### Clips from the start and end buttons

A start and end button, for example "Boss fight", gives one clip of the full event.

1. During the stream, press the button at the start of the event and again at the end.
2. After the stream, run `node clip.js <link of the stream> --dry`. Look for the lines with `full-` in the file name.
3. Run the command again without `--dry` to cut the clips.

- The clip starts `--before` seconds before the start marker and ends `--after` seconds after the end marker.
  For a range from 0:49:50 to 1:03:28, the default clip is from 0:49:20 to 1:03:43.
- The file name has `full-` and the name of the button, for example `<video ID>_00-49-20_full-Boss-fight.mp4`.
- The markers of the other buttons in the range, for example "Close call", become their own short clips as usual.
- To cut only the short clips, add `--no-ranges`.
- A range with no end marker gives no clip. The tool prints a message and continues.
- To cut the clips in a different tool, read `ranges` in the JSON file. Cut from `startSec` to `endSec`.
  For a local recording, use `startAt` and `endAt`.

## Limits

- The app has no login. Open it on the home network, over Tailscale, or through the Cloudflare Access gate.
