# Local VAD

호출 후 발화 시작·종료를 판단하는 로컬 VAD다. Silero VAD(sherpa-onnx)를 별도 프로세스(`vad-worker.ts`)에서 실행하고, 타이밍 규칙은 `vad-engine.ts`, 정책은 `vad-policy.ts`, Main과의 메시지는 `protocol.ts`에 둔다. 완료된 발화 구간(절대 샘플 범위)만 보고하며 추출은 캡처 버퍼가 맡는다. 기준은 [음성 명세](../../../docs/features/speech.md#구현-현황-로컬-음성-입력)다.
