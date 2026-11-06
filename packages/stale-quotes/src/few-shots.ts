/**
 * Voice reference for the draft prompt: the first 12 replied-to follow-up
 * texts (60-350 chars, deduped on the first 40 chars) from Matt's 367
 * harvested touches (analysis/data/stale-quotes/patterns.json, 2026-10-21).
 * Frozen here so the cloud worker needs no data file; the laptop runner
 * computed exactly this list from that file.
 */
export const FEW_SHOTS: readonly string[] = [
  'Hey there, happy Friday! Just checking in, I’ve still got a couple of timeslots open next week if you’d like these holes sealed up.',
  'Hi Cindy, I saw that you approved that estimate! We can get the repair scheduled whenever you are ready. We currently have an opening this Tuesday morning if that would work for you, my technician Mike can be there at 9am.',
  "Hi Santosh, just to update you, I've tried to get in touch with Nauman a few times and had no luck connecting with him so far. Have there been any updates on your end? We'd be able to have someone out there to fix your cracks as soon as Thursday if we can get the estimate approved.",
  'Hi Mary, I just figured I would check back in one more time and see if you were still looking for help on that crack repair. We’d love to get that fixed up for you. — Matt at Attack A Crack',
  'Hi Rob, I just wanted to check back in with you about the foundation repair work we discussed a few weeks ago. Is some or all of the work we quoted still on your radar to tackle soon? Let me know if we can be of any assistance and all the best with getting your home on the market! -- Matt at Attack A Crack',
  'Hi Tom, this is a reminder from Attack A Crack that our technician Mike will be at your home at 8:30 AM tomorrow, Monday, June 22. Please let me know if you have any questions.',
  'Hi Giovanna, I just wanted to check in and see if you were still considering moving forward with the repairs to the basement. Let me know, happy to answer any questions that may have come up since last week and hope all is well with the family!',
  'Thanks for reaching out to Attack A Crack! Apologies for missing your call, we are on the line with another customer. Please send us a text with your name and a description of the situation, along with photos of the foundation or bulkhead cracks you’re experiencing. We’ll get back to you as soon as possible. — Matt at Attack A Crack',
  'Hey Paul, just checking back in about those sidewalk repairs, let me know if you’ve made a decision on those or have any other questions.',
  "Hey Paul, thought I'd check back in again, any updates on getting us set up to do those sidewalk repairs?",
  'Hi Brian, just checking in to make sure the job with Mike went well Wednesday! If you have any questions please let me know. Also, if you are happy with our service we’d really appreciate a review. We are a small family business and each review is very impactful. You can follow the link here: https://g.page/r/CWHz-4-5ORnJEAE/review',
  "Hey Brendan, happy Thursday. Just checking in to see about your timing on those repairs, we've still got a couple of slots for next week open in our schedule if you're wanting to go ahead and get that done.",
];
