declare module "@react-native-ml-kit/translate-text" {
  export function translate(input: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
    downloadModelIfNeeded?: boolean;
  }): Promise<string>;

  const TranslateText: {
    translate(input: {
      text: string;
      sourceLanguage: string;
      targetLanguage: string;
      downloadModelIfNeeded?: boolean;
    }): Promise<string>;
  };

  export { TranslateText };
  export default TranslateText;
}
