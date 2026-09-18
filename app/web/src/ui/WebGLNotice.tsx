/** WebGL 을 못 쓰는 브라우저에 사정을 설명한다. 흰 화면으로 두지 않는다. */
export function WebGLNotice(): React.ReactElement {
  return (
    <div className="overlay" style={{ position: "relative", minHeight: "100%" }}>
      <div className="overlay__card">
        <p className="overlay__eyebrow">SC INTER</p>
        <h1 className="overlay__title">3D 를 그릴 수 없습니다</h1>
        <p className="overlay__body">
          이 브라우저에서 WebGL 을 쓸 수 없어 경기 화면을 띄우지 못했습니다. 다음을 확인해 주세요.
        </p>
        <ul style={{ textAlign: "left", color: "var(--text-muted)", margin: "0 0 24px" }}>
          <li>브라우저 설정에서 하드웨어 가속을 켰는지</li>
          <li>최신 Chrome·Edge·Safari·Firefox 인지</li>
          <li>원격 데스크톱이나 가상 머신이라면 GPU 를 쓸 수 있는지</li>
        </ul>
        <div className="overlay__actions">
          <button className="btn btn--primary" type="button" onClick={() => location.reload()}>
            다시 시도
          </button>
        </div>
      </div>
    </div>
  );
}
