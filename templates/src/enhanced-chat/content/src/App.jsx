import React from 'react';

const ORG_ID = window.__ESW_ORG_ID__ ?? '';
const CONFIG_NAME = window.__ESW_CONFIG_NAME__ ?? '';
const SITE_URL = window.__ESW_SITE_URL__ ?? '';
const SCRT_URL = window.__ESW_SCRT_URL__ ?? '';

export default function App() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <div id="bgImage" />
      <div id="mainContainer">
        <div id="logoContainer">
          <img
            src="https://c1.sfdcstatic.com/content/dam/sfdc-docs/www/logos/logo-salesforce.svg"
            width="65"
            alt="Salesforce logo"
          />
        </div>
        <div id="bodyContainer">
          <h1>Test Your Enhanced Web Chat Deployment</h1>
          <ol>
            <li>In the previous browser tab where you're signed into Salesforce, open the agent console.</li>
            <li>
              In the Omni-Channel utility or sidebar, make yourself available to accept incoming messaging sessions.
              <br />
              <button className={`accordion${open ? ' active' : ''}`} onClick={() => setOpen(o => !o)}>
                <img
                  className="chevron"
                  src={open
                    ? '/apexpages/slds/latest/assets/icons/utility/chevrondown_60.png'
                    : '/apexpages/slds/latest/assets/icons/utility/chevronright_60.png'}
                  alt=""
                />
                Show Me Where
              </button>
              {open && (
                <div id="videoDemoContainer">
                  <img
                    style={{ display: 'block', maxWidth: 330, maxHeight: 452 }}
                    className="vidyard-player-embed"
                    src="https://play.vidyard.com/6udN7LzkmqU8RgRvyoKDrS.jpg"
                    data-uuid="6udN7LzkmqU8RgRvyoKDrS"
                    data-v="4"
                    data-type="inline"
                    data-width="330"
                    data-height="452"
                    alt="Demo video"
                  />
                </div>
              )}
            </li>
            <li>In this tab, open the chat conversation window and send a message as a customer.</li>
            <li>In Salesforce, accept the messaging session and send a response.</li>
            <li>Chat back and forth, and then end the conversation.</li>
          </ol>
        </div>
      </div>
    </>
  );
}
