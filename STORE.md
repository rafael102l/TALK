# הכנה לחנויות

## Android

- `applicationId`: `app.talk.ptt`
- הרשאות: מיקרופון, אנשי קשר, התראות
- בניית production: `cd apps/mobile && eas build --platform android --profile production`

## iOS

- `bundleIdentifier`: `app.talk.ptt`
- רקע: `audio` + `remote-notification`
- בניית production: `eas build --platform ios --profile production`
- ב-iOS השמעה אוטומטית כשהאפליקציה סגורה מוגבלת; פוש מעיר את האפליקציה

## חובה לפני הגשה

- מדיניות פרטיות (קול ביומטרי + אנשי קשר)
- הסכמה מפורשת לדגימת קול במסך השיבוט
- הסבר למה צריך אנשי קשר
- אייקונים וצילומי מסך
- מפתחות AI ו-SMS בפרודקשן, לא קודי OTP של פיתוח
