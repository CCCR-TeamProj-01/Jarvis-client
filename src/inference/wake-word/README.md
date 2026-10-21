# Local wake word

F-024 / #49의 Vosk 호출어 어댑터다. 대기 중 PCM을 Electron utilityProcess에서 처리하고 서버 연결 없이 `WakeWordEvent`를 낸다. 명령 STT·응답 TTS는 서버 역할을 유지한다.

- 공식 `vosk-model-small-ko-0.22`와 Vosk 0.3.39 네이티브 엔진을 고정 해시로 설치한다(`pnpm models:wake:fetch`). 원본·캐시는 git에 넣지 않는다.
- 공식 npm `vosk`의 ffi-napi 4.0.3은 Node 24.18.0/macOS arm64에서 빌드 실패를 재현했다. Koffi 3.3.3으로 Vosk C API를 호출하며 Renderer에 FFI를 노출하지 않는다.
- 지원 자산: macOS x64/arm64 universal, Windows x64. 다른 플랫폼·CPU는 활성화 실패로 처리한다. 실제 검증 환경과 완료 여부는 PR·진행 로그에 기록한다.
- 로드 시 `자비스` 어휘를 확인한다. `자비스야`는 이번 모델에 없다. 유사 문자열로 우회 호출하지 않는다. `[자비스, <UNK>]` 제한 문법에서는 비호출 합성 문장에 오탐이 재현돼 사용하지 않는다. 전체 어휘 그래프로 인식하고 정확한 호출어 단어와 경계만 반환한다.
- 인식 결과의 정확한 단어·시각·신뢰도(잠정 0.3)만 사용한다. 브라우저를 거친 합성 호출에서 정확한 단어의 신뢰도가 약 0.34로 낮아져 초기 0.85 기준으로는 감지하지 못했다. 0.3은 초기 검증용 값이며 실제 화자·잡음·영상 재생으로 보정해야 한다. 부분 텍스트만으로 호출하지 않으며 신뢰도를 실제 성공률로 간주하지 않는다.
- `vosk_recognizer_reset`은 시간 원점을 초기화하지 않아 새 capture마다 decoder를 다시 만들고 모델만 재사용한다. Main은 프로세스·capture 세대·PCM 순서와 IPC 미처리량을 검증한다.
- Vosk 엔진/모델: Apache-2.0([모델](https://alphacephei.com/vosk/models), [C API](https://github.com/alphacep/vosk-api/blob/master/src/vosk_api.h)). 라이선스 사본은 `resources/licenses/`에서 패키지에 포함한다. Koffi: MIT(의존성의 라이선스 포함).

일반 본문·오디오·인식된 대기 발화는 로그나 디스크에 기록하지 않는다. 호출어 적용의 제품 규칙은 `docs/features/interaction-ui.md`의 CALL-01과 `docs/features/speech.md`를 따른다.
