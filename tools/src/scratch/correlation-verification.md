# GA4 ↔ Pipedrive Timestamp Verification

**Purpose:** Determine the correct timezone for both systems so correlation math works.

**What to do:** Pick a few calls you remember receiving. Check which column matches when your phone actually rang. Then we'll know the timezone and can fix the correlation.

---

## Pipedrive Inbound Calls (3/21 – 4/02)

Which column matches when your phone actually rang?

| Raw API Value | If UTC → Eastern | If Already Eastern | Who |
|---|---|---|---|
| 2026-03-21 14:34:14 | 10:34 AM | 2:34 PM | Michael Harrington |
| 2026-03-23 01:26:49 | 9:26 PM (3/22) | 1:26 AM | Sean |
| 2026-03-23 11:50:13 | 7:50 AM | 11:50 AM | Sean |
| 2026-03-23 12:34:01 | 8:34 AM | 12:34 PM | Michael Harrington |
| 2026-03-23 13:48:27 | 9:48 AM | 1:48 PM | Kathryn Grealish / The Residential Group |
| 2026-03-23 15:22:00 | 11:22 AM | 3:22 PM | Jennifer Ryan |
| 2026-03-23 16:06:26 | 12:06 PM | 4:06 PM | Michael Harrington |
| 2026-03-23 16:09:59 | 12:09 PM | 4:09 PM | Michael |
| 2026-03-23 19:14:11 | 3:14 PM | 7:14 PM | Ryan |
| 2026-03-23 19:36:07 | 3:36 PM | 7:36 PM | Erice Nyambi |
| 2026-03-23 19:50:31 | 3:50 PM | 7:50 PM | Matt |
| 2026-03-24 13:38:19 | 9:38 AM | 1:38 PM | Michael |
| 2026-03-24 13:43:57 | 9:43 AM | 1:43 PM | Unknown Lead +18176990074 |
| 2026-03-24 15:35:12 | 11:35 AM | 3:35 PM | Unknown Lead +18559611602 |
| 2026-03-24 19:21:36 | 3:21 PM | 7:21 PM | Michael O'Malley |
| 2026-03-24 21:34:31 | 5:34 PM | 9:34 PM | Steve |
| 2026-03-25 12:38:11 | 8:38 AM | 12:38 PM | Brian |
| 2026-03-25 15:11:18 | 11:11 AM | 3:11 PM | Steve Glinski |
| 2026-03-25 16:55:18 | 12:55 PM | 4:55 PM | Steve Glinski |
| 2026-03-25 16:55:18 | 12:55 PM | 4:55 PM | Unknown Lead +17817241904 |
| 2026-03-25 17:04:46 | 1:04 PM | 5:04 PM | Matt |
| 2026-03-26 13:08:26 | 9:08 AM | 1:08 PM | Unknown Lead +18579987699 |
| 2026-03-26 14:20:49 | 10:20 AM | 2:20 PM | Michael Harrington |
| 2026-03-26 14:39:34 | 10:39 AM | 2:39 PM | Unknown Lead +16175051297 |
| 2026-03-26 15:11:25 | 11:11 AM | 3:11 PM | Unknown Lead +16173443536 |
| 2026-03-26 15:37:46 | 11:37 AM | 3:37 PM | Unknown Lead +16177854706 |
| 2026-03-26 16:45:08 | 12:45 PM | 4:45 PM | Paul Nock |
| 2026-03-26 17:00:48 | 1:00 PM | 5:00 PM | Daniel |
| 2026-03-26 18:19:49 | 2:19 PM | 6:19 PM | David |
| 2026-03-26 22:10:12 | 6:10 PM | 10:10 PM | Unknown Lead +13232859676 |
| 2026-03-27 15:09:37 | 11:09 AM | 3:09 PM | Matt |
| 2026-03-27 15:27:29 | 11:27 AM | 3:27 PM | Unknown Lead +13082233070 |
| 2026-03-28 14:27:13 | 10:27 AM | 2:27 PM | Jay |
| 2026-03-28 15:16:49 | 11:16 AM | 3:16 PM | Eric Yang |
| 2026-03-28 15:17:45 | 11:17 AM | 3:17 PM | Unknown Lead +16174160901 |
| 2026-03-28 15:49:38 | 11:49 AM | 3:49 PM | Matt |
| 2026-03-28 15:53:02 | 11:53 AM | 3:53 PM | Matt |
| 2026-03-28 15:58:16 | 11:58 AM | 3:58 PM | Eric Yang |
| 2026-03-30 13:12:08 | 9:12 AM | 1:12 PM | Amanda Bruno |
| 2026-03-30 17:59:40 | 1:59 PM | 5:59 PM | Helen Timental |
| 2026-03-30 20:02:42 | 4:02 PM | 8:02 PM | Donna Pellegrino |
| 2026-03-30 20:20:13 | 4:20 PM | 8:20 PM | Doreina Ramos |
| 2026-03-30 20:52:45 | 4:52 PM | 8:52 PM | Anna |
| 2026-03-31 21:03:56 | 5:03 PM | 9:03 PM | Unknown Lead +12403716591 |
| 2026-04-01 15:01:31 | 11:01 AM | 3:01 PM | Nate Moore |
| 2026-04-01 15:20:51 | 11:20 AM | 3:20 PM | Ronaisha Green |
| 2026-04-01 15:39:43 | 11:39 AM | 3:39 PM | Kathleen Kisler |
| 2026-04-01 17:07:09 | 1:07 PM | 5:07 PM | Brent Harris |
| 2026-04-01 17:15:04 | 1:15 PM | 5:15 PM | Helen Timental |
| 2026-04-01 17:34:01 | 1:34 PM | 5:34 PM | Brent Harris |
| 2026-04-01 17:47:25 | 1:47 PM | 5:47 PM | Unknown Lead +18559611602 |
| 2026-04-01 17:51:03 | 1:51 PM | 5:51 PM | Lacey McCafferty |
| 2026-04-01 19:39:47 | 3:39 PM | 7:39 PM | Unknown Lead +13392222133 |

---

## GA4 Website Clicks — MA Line Only (3/21 – 4/02)

These are every phone/text click on the Massachusetts number from the website.

| Raw dateHourMinute | Time (same either way) | Event | Source | Page |
|---|---|---|---|---|
| 202603250336 | 3:36 AM | CALL | (direct) | / |
| 202603251518 | 3:18 PM | TEXT | duckduckgo/organic | /services/wall-crack-repair |
| 202603251519 | 3:19 PM | TEXT | duckduckgo/organic | /about |
| 202603251910 | 7:10 PM | TEXT | google/organic | / |
| 202603252016 | 8:16 PM | TEXT | google/cpc | / |
| 202603260942 | 9:42 AM | CALL | duckduckgo/organic | / |
| 202603280848 | 8:48 AM | CALL | google/cpc | /services/leaky-bulkhead-repair/ |
| 202603280848 | 8:48 AM | TEXT | google/cpc | /services/leaky-bulkhead-repair/ |
| 202603280852 | 8:52 AM | TEXT | (direct) | /massachusetts/worcester |
| 202603290259 | 2:59 AM | CALL | google/gbp | / |
| 202603290300 | 3:00 AM | TEXT | google/gbp | /about |
| 202603290301 | 3:01 AM | CALL | google/gbp | /about |
| 202603291304 | 1:04 PM | TEXT | google/organic | /massachusetts/ |
| 202603301056 | 10:56 AM | CALL | google/cpc | /massachusetts |
| 202604010759 | 7:59 AM | CALL | (not set) | / |

---

## What to Check

1. **Pick 2-3 Pipedrive calls you remember.** Does the "If UTC → Eastern" or "If Already Eastern" time match when your phone rang?

2. **Once we know Pipedrive's timezone**, we can align the GA4 clicks correctly and rerun correlation.

3. **GA4 timezone** can be confirmed in GA4 Admin → Property Settings → Reporting Time Zone. But knowing Pipedrive first is more useful since you have real memory of call times.
