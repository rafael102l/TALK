# TALK

אוקי-טוקי עם תרגום קול. כל נמען שומע בשפה שהוא הגדיר, ובקול של הדובר כשיש דגימת קול.

## מה בפנים

- `apps/mobile` — Expo (React Native), Android + iOS
- `apps/api` — NestJS, Socket.io, Prisma
- `packages/shared` — שפות, אירועי סוקט, נרמול E.164

## הרצה מקומית

1. התקינו תלויות וצרו את מסד SQLite המקומי:

```bash
npm install
npx prisma db push --schema apps/api/prisma/schema.prisma
```

אם יש Docker אפשר גם `docker compose up -d` ל-Redis/Postgres, אבל ברירת המחדל המקומית היא קובץ SQLite ב-`apps/api/prisma/dev.db`.

3. הריצו את ה-API מתוך `apps/api` (כדי שקובץ `.env` ייטען):

```bash
npm run dev:api
```

4. האפליקציה (דורשת [EAS Dev Client](https://docs.expo.dev/develop/development-builds/introduction/), לא Expo Go — מיקרופון ואנשי קשר):

```bash
cd apps/mobile
npx expo start --dev-client
```

בפיתוח קוד ה-OTP מודפס לקונסולת השרת, וגם `000000` מתקבל.

כתובת ה-API מהמכשיר:

- אמולטור אנדרואיד: `http://10.0.2.2:3000`
- מכשיר אמיתי: `EXPO_PUBLIC_API_URL=http://<IP-של-המחשב>:3000`

## מפתחות AI (אופציונלי)

בלי מפתחות המערכת עובדת כאוקי-טוקי: אותה הקלטה מגיעה לכולם. עם מפתחות ב-`apps/api/.env` נכנס תרגום ושיבוט קול:

- `DEEPGRAM_API_KEY` — דיבור לטקסט
- `DEEPL_API_KEY` או `OPENAI_API_KEY` — תרגום
- `ELEVENLABS_API_KEY` — שיבוט קול ו-TTS
- `TWILIO_*` — SMS לקוד ולהזמנות

## מסכים

הרשמה במספר → שם ושפות → דגימת קול → שידור PTT → בחירת אנשים / כולם → היסטוריה והגדרות.
