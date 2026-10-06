# Bagh Haru Studio

This is a private app for our class. Approved classmates sign in with Google, upload photos or videos, and publish them to the class Instagram account.

The app is deployed on Cloudflare: [baghharu.neerrn.com](https://baghharu.neerrn.com). It uses Cloudflare D1 for app data, private R2 storage for uploads, and a Queue for publishing.

In **Create**, upload your finished photo or video. Use **@ Mention people** for Stories or **Tag people** for feed media. The mention dialog supports dragging and keyboard positioning. Collaborators, Reel cover frames, feed sharing, carousel reordering, drafts and upload recovery are retained. There is no image/video editor or Studio music.

Instagram catalog music is supported by Meta's API for **Reels only**, through Facebook Login and a linked Facebook Page. The class Facebook connection is active. Meta returns a limited catalog, so some songs from Instagram are unavailable. Finish videos in Instagram Edits before uploading. Exported music may appear as original audio. To reconnect, fill `META_FACEBOOK_APP_ID`, `META_FACEBOOK_APP_SECRET`, `META_FACEBOOK_USER_ACCESS_TOKEN` and `META_FACEBOOK_BUSINESS_ID` in `.dev.vars`, then run `npm run meta:connect` with Node 22. Renew before 4 December 2026. Credentials are not entered through the website. Post, Story and carousel music, exact song-section selection and mention font/size controls are not documented API capabilities.

## Run on your computer

You need Node.js 22 and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply insta-portal --local
npm run dev
```

To only build the app, run `npm run build`. No secret keys are needed for the build alone. To run Google sign-in, uploads, and Instagram publishing locally, put the real values in `.dev.vars`:

- Google sign-in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- First admin setup: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN`
- Instagram publishing: `META_ACCESS_TOKEN`, `META_IG_USER_ID`
- Upload security: `MEDIA_URL_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

`APP_ORIGIN`, `META_API_VERSION`, and `MEDIA_BUCKET` are settings, not secret keys. For local Google sign-in, add `http://localhost:5173/api/auth/google/callback` as an allowed redirect in Google settings. Keep real keys in `.dev.vars`; do not put them in Git or chat.

## Please do not brute-force

There are limits to stop too many requests:

- Google sign-in can be started 20 times in 10 minutes from one IP address.
- Each classmate can start 3 new posts per hour and 5 per day. Up to 3 posts can be processing at once.
- Admins can add 30 classmates per hour. First admin setup allows 5 tries per hour.

If you reach a limit, wait and try again later. Please do not keep clicking or guess setup codes.

Launch checks (6 October 2026): 80 app tests, 13 setup tests and nine browser tests pass. Live catalog search, preview playback and upload guidance pass. Publishing Queue, dead-letter Queue and two-minute cron are attached; no publishing jobs are stuck. Worker version: `5a62f355-7239-44f2-a217-ffc7a17ca070`. Existing posts were unchanged. Final published audio attribution was not tested; previous real uploads were verified with unpublished containers.
