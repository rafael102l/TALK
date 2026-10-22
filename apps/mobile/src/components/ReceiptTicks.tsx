import { MessageReceipt } from "@talk/shared";
import { StyleSheet, Text, View } from "react-native";

export function ReceiptTicks({ receipt }: { receipt?: MessageReceipt | null }) {
  const status = receipt || "sent";
  const color = status === "read" ? "#1E78F0" : "rgba(17,27,33,0.45)";
  const mark = status === "sent" ? "✓" : "✓✓";
  return (
    <View style={styles.wrap}>
      <Text style={[styles.mark, { color }]}>{mark}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginLeft: 4 },
  mark: { fontSize: 12, fontWeight: "800", letterSpacing: -1 },
});
