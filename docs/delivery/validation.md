# 배포와 검증 계획

배포 기준, MVP 완료 시나리오, 미확정 항목과 구현 순서다.

## 배포와 검증

### 배포 단위

- 클라이언트: Windows·macOS 및 지원 CPU별 설치 패키지. 로컬 KWS 후보 엔진과 별도 한국어 모델, Silero VAD, WASM·네이티브 바이너리를 버전 고정해 포함하거나 검증된 초기 다운로드로 제공한다. 각 엔진·모델·학습 데이터의 라이선스 및 재배포 조건을 개별 확인한다. STT·TTS 모델은 클라이언트에 포함하지 않는다.
- 서버: 모듈을 묶은 API·WSS 애플리케이션 1개, STT·TTS 처리와 MySQL. 인증·외부 API 비밀은 배포 설정에서 주입하고 음성 처리량·자원 사용량을 관찰한다.
- 클라이언트·서버 프로토콜은 버전 관리하고 지원하지 않는 도구·버전은 명확히 거절한다.
- macOS 서명·공증과 Windows 배포·네이티브 모듈 로딩은 실제 산출물 기준으로 검증한다. 마이크 권한·백그라운드 입력·로컬 KWS/VAD 실행과 모델 파일 경로, 서버 STT 업로드·TTS 오디오 재생도 설치 패키지에서 확인한다.

### MVP 완료 시나리오

| 시나리오 | 완료 조건 |
| --- | --- |
| 연속 음성 명령 | 대기 KWS가 “자비스”를 감지하고 Ring Buffer로 “크롬 실행해 줘” 시작을 보존. VAD 완료 구간만 서버 STT로 전송하고 서버 인식 텍스트로 도구를 선택; 실제 실행·전환 결과에 맞게 안내 |
| 후속 발화·무음 | TTS 완료 후 호출어 없이 후속 발화 처리. 발화 시작 대기·종료 무음·최대 발화·후속 대기 타임아웃과 빈 STT 결과 검증 |
| TTS 자체 재인식 | 서버 TTS 오디오 재생 중 KWS/VAD가 자체 출력을 요청으로 만들지 않음. 재생 종료 후에만 후속 발화 대기 |
| 음성 전송·장애 | 대기 음성·무음·취소된 구간은 전송하지 않음. 네트워크 단절·STT 실패 시 오디오를 대기열에 저장하거나 자동 재전송하지 않음. TTS 실패 시 텍스트 결과 표시 |
| 음성 중지·권한 철회 | 마이크 중지·권한 철회·취소·일시 중지에서 인식 엔진 정지, 버퍼 폐기, 늦은 결과 무시, 허용될 때만 KWS 대기 복귀 |
| 제스처 | 명시적 시작, 커서 이동, Pinch 1회당 클릭 1회, 최근 작업 전환, 추적 손실 중 입력 없음 |
| 로컬 중지 | 서버 단절·추론 지연 중에도 중지 가능. 누적 이동·클릭이 중지 후 재생되지 않음 |
| 최소 UI | 평소 창 숨김, 상태 표시가 작업 포커스를 빼앗지 않음, 필요한 순간만 입력·확인 창 표시 |
| 상태 독립 | 대화 종료·결과 창 닫기 후에도 제스처·호출 대기가 설정대로 유지 |
| 추천 | 기록 근거가 있으며 승인만 실행. 거절·닫기·만료·중복 승인에서 실행 없음 |
| 일정 | 1종 연결·조회·해제. 사용자 시간대·종일·반복 일정과 인증 오류 반영 |
| 재연결·취소 | 만료·취소 도구 재실행 없음. 결과 불명 시 자동 중복 실행 대신 미확인 처리 |
| 권한·기록 | 권한 거부·철회 안내, 수집 중지·삭제가 로컬 대기열·서버·집계에 반영 |
| 교차 플랫폼 | 위 흐름을 지원 Windows·macOS 실제 환경과 배포 패키지에서 확인 |

성능은 실제 한국어 “자비스” 호출어의 인식률·오호출 수(잡음·TTS 재생 포함), 호출 후 연속 명령 누락률, VAD 발화 시작·종료 지연과 무음 분할 오류, 서버 STT 정확도·왕복 지연, 서버 TTS 생성·재생 시작 지연, 음성 요청 동시 처리량·비용, 영상 입력부터 OS 입력까지의 지연, 추적 손실 후 입력 중단 시간, 대기 중 CPU·메모리·전력으로 측정한다. 목표 수치는 기준 기기와 측정 방법을 정한 후 확정하며, 라이브러리 신뢰도 점수를 실제 성공률로 대신하지 않는다.

## 개발 전 결정 목록과 구현 순서

### 미확정 항목

| 항목 | 결정할 내용 |
| --- | --- |
| 캘린더 | Google Calendar 또는 Outlook 우선 지원 |
| 서버 | 언어·프레임워크·인증 방식·배포 환경 |
| 인식·음성 서비스 | sherpa-onnx KWS와 한국어 “자비스” 모델의 실제 성능·OS/CPU 패키징·엔진/모델/학습 데이터 라이선스·재배포 조건. 부적합 시 WakeWordDetector 교체. Silero 실행 방식, 서버 STT·TTS 엔진·언어 품질·확장 방식 |
| 음성 계약 | 발화·TTS 오디오 형식, 최대 발화 시간·바이트, 요청 기한, TTS 오디오 전달 방식, 서버의 임시 보관·삭제 기준 |
| 제스처 | 호출·전환 동작, 임계값·재활성 조건, 활성 손, 화면 좌표 보정 |
| 지원 환경 | OS 최소 버전·CPU·기준 기기·단일 또는 다중 모니터 범위 |
| 입력 구현 | Windows·macOS 입력·창 제어 라이브러리와 권한 처리 |
| 대화 | 기본 단축키, 발화 시작 대기·종료 무음·최대 발화·후속 발화 대기·요청 유효 시간, TTS 종료/중단 후 재개 정책. 응답 중 끼어들기는 후속 범위 |
| 추천 | 분석 구간·최소 기록·점수·재노출 제한·승인 기한 |
| 보관·삭제 | 행동·운영 기록 보관 기간, 삭제 적용 기한, 백업 만료와 복원 시 재삭제 정책 |
| 성능 | 기준 기기별 지연·인식률·자원 사용량 목표 |

### 권장 구현 순서

1. Electron 백그라운드 미디어 입력 → MediaPipe → 실제 OS 커서·클릭 → 로컬 중지를 두 OS에서 검증한다.
2. 트레이·단축키·오버레이·권한·Main 상태 관리와 공통 도구 인터페이스를 만든다.
3. 텍스트 요청으로 서버 해석 → WSS 도구 요청 → 앱 실행 → 실제 결과 확인을 연결한다.
4. AudioCaptureManager와 Ring Buffer → 교체 가능한 WakeWordDetector(sherpa-onnx 우선 검증) → SpeechSessionController → 호출 후 Silero VAD → 완료 발화의 인증된 서버 STT 업로드 → 서버 TTS 오디오 재생을 기존 도구 요청 흐름에 연결한다. 연속 발화·후속 발화·무음·단절·중지·권한 철회를 함께 검증한다.
5. 캘린더 1종과 실행 이력 기반 추천·승인 흐름을 추가한다.
6. 삭제·취소·단절·권한 철회와 배포 패키지 검증을 완료한 뒤 확장 기능을 검토한다.

## 기술 참고 자료

- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [MediaPipe Hand Landmarker Web](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- [Google MediaPipe Web Worker 예제](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/hand-landmarker.worker.ts)
- [sherpa-onnx Keyword Spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- [sherpa-onnx LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)
- [Silero VAD](https://github.com/snakers4/silero-vad)

이 문서의 기능 범위와 모듈 경계는 프로젝트 설계안이며, 라이브러리·성능·배포 지원 범위의 최종 확정은 대상 환경 기술 검증 결과에 따른다.
