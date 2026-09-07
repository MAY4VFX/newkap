import {TooltipIcon} from '../../../vectors';
import {useState, useEffect} from 'react';
import {shake} from '../../../utils/inputs';

// Snap points the slider sticks to; intermediate values are still allowed
// everywhere else along the track.
export const SPEED_SNAP_POINTS = [0.25, 0.5, 0.75, 1, 1.2, 1.5, 2, 5, 10, 20];
export const MIN_SPEED = SPEED_SNAP_POINTS[0];
export const MAX_SPEED = SPEED_SNAP_POINTS[SPEED_SNAP_POINTS.length - 1];
export const DEFAULT_SPEED = 1;

interface Props {
  value: number;
  onChange: (newValue: number) => void;
}

// The <input type="range"> track is linear, but speed reads naturally on a
// logarithmic scale (0.5x should feel as far from 1x as 2x does), so the
// slider's raw position is mapped through log space to get the actual speed.
const TRACK_STEPS = 1000;
const LOG_MIN = Math.log(MIN_SPEED);
const LOG_MAX = Math.log(MAX_SPEED);

const speedToPosition = (speed: number) => ((Math.log(speed) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * TRACK_STEPS;
const positionToSpeed = (position: number) => Math.exp(LOG_MIN + (position / TRACK_STEPS) * (LOG_MAX - LOG_MIN));

// Close enough to a snap point's position (in track units) to lock onto it.
const SNAP_THRESHOLD = TRACK_STEPS * 0.015;
const SNAP_POSITIONS = SPEED_SNAP_POINTS.map(speedToPosition);

const roundSpeed = (speed: number) => Math.round(speed * 100) / 100;

const clampSpeed = (speed: number) => Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);

const speedFromPosition = (position: number) => {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (const [index, snapPosition] of SNAP_POSITIONS.entries()) {
    const distance = Math.abs(position - snapPosition);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  if (nearestDistance <= SNAP_THRESHOLD) {
    return SPEED_SNAP_POINTS[nearestIndex];
  }

  return roundSpeed(positionToSpeed(position));
};

const formatSpeed = (speed: number) => roundSpeed(speed).toString();

const SpeedSlider = (props: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [valueText, setValueText] = useState(formatSpeed(props.value));

  useEffect(() => {
    setValueText(formatSpeed(props.value));
  }, [props.value]);

  const onChange = event => {
    setValueText(event.currentTarget.value);
  };

  const onBlur = event => {
    const {currentTarget} = event;
    const value = Number.parseFloat(currentTarget.value);

    if (Number.isFinite(value) && value >= MIN_SPEED && value <= MAX_SPEED) {
      const rounded = roundSpeed(value);
      props.onChange(rounded);
      setValueText(formatSpeed(rounded));
    } else if (Number.isFinite(value)) {
      const clamped = clampSpeed(value);
      props.onChange(clamped);
      setValueText(formatSpeed(clamped));
      shake(currentTarget);
    } else {
      setValueText(formatSpeed(props.value));
      shake(currentTarget);
    }
  };

  const onKeyDown = event => {
    if (event.key === 'Enter') {
      onBlur(event);
    }
  };

  const onSliderChange = event => {
    const position = Number.parseInt(event.currentTarget.value, 10);
    const speed = speedFromPosition(position);
    props.onChange(speed);
    setValueText(formatSpeed(speed));
  };

  return (
    <div className="container">
      {isOpen && <div
        className="overlay" onClick={() => {
          setIsOpen(false);
        }}/>}
      <input
        type="text"
        className="value"
        value={valueText || ''}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={() => {
          setIsOpen(true);
        }}
      />
      {
        isOpen && (
          <div
            className="popup" onClick={event => {
              event.stopPropagation();
            }}
          >
            <input
              type="range"
              className="slider"
              list="speed-snap-points"
              min={0}
              max={TRACK_STEPS}
              step={1}
              value={speedToPosition(props.value || MIN_SPEED)}
              onChange={onSliderChange}
              onBlur={() => {
                setIsOpen(false);
              }}
            />
            <datalist id="speed-snap-points">
              {SNAP_POSITIONS.map(position => <option key={position} value={position}/>)}
            </datalist>
            <div className="arrow">
              <TooltipIcon fill="var(--slider-popup-background)" hoverFill="var(--slider-popup-background)"/>
            </div>
          </div>
        )
      }
      <style jsx>{`
          .container {
            width: 100%;
            height: 100%;
            position: relative;
            font-size: 12px;
            color: white;
          }

          .value {
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            padding: 4px 8px;
            text-align: center;
            font-size: 12px;
            -webkit-appearance: none;
            outline: none;
            color: white;
            border: none;
            z-index: 50;
            position: relative;
            box-shadow: inset 0px 1px 0px 0px rgba(255, 255, 255, 0.04), 0px 1px 2px 0px rgba(0, 0, 0, 0.2);
          }

          .value:hover,
          .value:focus {
            background: hsla(0, 0%, 100%, 0.2);
          }

          .arrow {
            position: absolute;
            width: 24px;
            height: 12px;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
          }

          .popup {
            position: absolute;
            height: 48px;
            padding: 0 32px;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-bottom: 16px;
            background: var(--slider-popup-background);
            box-shadow: 0 8px 16px 0 rgba(0, 0, 0, 0.40);
            z-index: 50;
            border-radius: 2px;
            -webkit-app-region: no-drag;
            display: flex;
            align-items: center;
          }

          .overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: transparent;
            z-index: 49;
          }

          .slider {
            width: 144px;
            -webkit-appearance: none;
            outline: none;
            background: transparent;
            z-index: 20;
          }

          .slider::-webkit-slider-runnable-track {
            width: 100%;
            height: 4px;
            border-color: transparent;
            background: var(--slider-background-color);
            border-radius: 4px;
            box-shadow: 0px 0px 1px rgba(0, 0, 0, 0.4);
          }

          .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            height: 16px;
            width: 16px;
            border-radius: 50%;
            background: var(--slider-thumb-color);
            box-shadow: 0px 1px 2px rgba(0, 0, 0, 0.4);
            margin-top: -6px;
            z-index: 50;
          }

          .slider:focus::-webkit-slider-thumb {
            border: 1px solid var(--kap);
          }
        `}</style>
    </div>
  );
};

export default SpeedSlider;
