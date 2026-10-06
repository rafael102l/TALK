import * as Contacts from "expo-contacts";

export type DeviceContact = { phone: string; displayName: string };

export class ContactsPermissionError extends Error {
  needsSettings: boolean;
  constructor(needsSettings: boolean) {
    super(needsSettings ? "צריך לאשר גישה לאנשי קשר בהגדרות הטלפון" : "אין הרשאה לאנשי קשר");
    this.needsSettings = needsSettings;
  }
}

export async function loadDeviceContacts(opts?: { request?: boolean }): Promise<DeviceContact[]> {
  const existing = await Contacts.getPermissionsAsync();
  let permission = existing;
  if (existing.status !== "granted") {
    if (opts?.request === false) return [];
    permission = await Contacts.requestPermissionsAsync();
  }
  if (permission.status !== "granted") {
    throw new ContactsPermissionError(permission.canAskAgain === false);
  }

  const rows: DeviceContact[] = [];
  let pageOffset = 0;
  const pageSize = 300;
  for (;;) {
    const page = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
      pageSize,
      pageOffset,
      sort: Contacts.SortTypes.FirstName,
    });
    for (const contact of page.data) {
      for (const phone of contact.phoneNumbers ?? []) {
        const number = phone.number?.trim() ?? "";
        if (!number) continue;
        rows.push({
          phone: number,
          displayName: contact.name?.trim() || number,
        });
      }
    }
    if (!page.hasNextPage || page.data.length === 0) break;
    pageOffset += page.data.length;
    if (pageOffset > 8000) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return rows;
}
