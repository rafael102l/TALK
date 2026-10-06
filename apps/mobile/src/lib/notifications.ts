import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import { emitIncomingPush, payloadFromPush } from "./incomingPush";

const PUSH_KEY = "talk.pushToken";

Notifications.setNotificationHandler({
  handleNotification: async () => {
    const active = AppState.currentState === "active";
    return {
      shouldShowAlert: !active,
      shouldPlaySound: !active,
      shouldSetBadge: false,
      shouldShowBanner: !active,
      shouldShowList: true,
    };
  },
});

let attached = false;

export function attachNotificationListeners() {
  if (attached) return;
  attached = true;
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown>;
    const payload = payloadFromPush(data);
    if (payload) emitIncomingPush(payload, true);
  });
  Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request.content.data as Record<string, unknown>;
    const payload = payloadFromPush(data);
    if (payload && AppState.currentState !== "active") emitIncomingPush(payload, false);
  });
}

export async function takeLastNotification() {
  const last = await Notifications.getLastNotificationResponseAsync();
  if (!last) return null;
  return payloadFromPush(last.notification.request.content.data as Record<string, unknown>);
}

export async function registerPushToken(token: string) {
  attachNotificationListeners();
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("talk-ptt", {
      name: "שידורי TALK",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const push = await Notifications.getExpoPushTokenAsync();
  const saved = await SecureStore.getItemAsync(PUSH_KEY).catch(() => null);
  if (saved === push.data) return;
  await api("/users/me/push-token", {
    method: "POST",
    token,
    body: JSON.stringify({ token: push.data }),
  });
  await SecureStore.setItemAsync(PUSH_KEY, push.data).catch(() => undefined);
}
