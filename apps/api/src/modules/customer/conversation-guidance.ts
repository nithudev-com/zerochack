export const isBriefConfirmation = (content: string) => /^(?:yes|yep|yeah|ok|okay|sure|go ahead|continue|please)[\s.!]*$/iu.test(content.trim());
export const needsInspectionConfirmation = (content: string, previousAssistant: string) => isBriefConfirmation(content) && /\b(?:security assessment|read.only.{0,30}(?:scan|assessment|inspection)|run the scan|inspect website)\b/iu.test(previousAssistant);

export const inspectionNextStep = 'Choose **Inspect website** in the security chat, or send **Run the scan**, to start checking the connected website. This authorizes inspection, not file changes. I will use the saved website and SSH details rather than ask for them again. Live security repair is not enabled in this deployment; no repair will be claimed or applied.';
