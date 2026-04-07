import { useEffect, useState } from 'react';
import { AdaptiveDashboard } from './adaptive/adaptive-dashboard.js';
import { recordTopicQuizResult, StoredAdaptiveState, syncAdaptiveState } from './adaptive/storage.js';
import {
  certificationTracks,
  getCategory,
  getTopic,
  getTopicsForTrack,
  serviceCategories,
} from './data/curriculum.js';
import { QuizPanel } from './quiz/quiz-panel.js';
import { CertificationTrackId, Topic } from './types.js';
import { TutorPanel } from './tutor/tutor-panel.js';
import { StoredQuizResultRecord } from './quiz/storage.js';

const defaultTrackId: CertificationTrackId = 'cloud-practitioner';
const defaultTopicId = 's3';

interface ReviewLaunchRequest {
  launchId: number;
  topicId: string;
}

function TopicLinkButton({
  label,
  topic,
  onSelect,
}: {
  label: string;
  topic: Topic;
  onSelect: (topicId: string) => void;
}) {
  return (
    <button
      type="button"
      className="relationship-chip"
      onClick={() => onSelect(topic.id)}
      aria-label={`${label}: ${topic.name}`}
    >
      <span className="relationship-label">{label}</span>
      <span>{topic.name}</span>
    </button>
  );
}

export default function App() {
  const [selectedTrackId, setSelectedTrackId] = useState<CertificationTrackId>(defaultTrackId);
  const [selectedTopicId, setSelectedTopicId] = useState(defaultTopicId);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [adaptiveState, setAdaptiveState] = useState<StoredAdaptiveState>(() => syncAdaptiveState(defaultTrackId));
  const [reviewLaunchRequest, setReviewLaunchRequest] = useState<ReviewLaunchRequest | null>(null);

  const visibleTopics = getTopicsForTrack(selectedTrackId);
  const visibleCategories = serviceCategories.filter(
    (category) => getTopicsForTrack(selectedTrackId, category.id).length > 0,
  );
  const selectedTrack = certificationTracks.find((track) => track.id === selectedTrackId) ?? certificationTracks[0];
  const visibleTopicIds = new Set(visibleTopics.map((topic) => topic.id));
  const activeTopicId = visibleTopicIds.has(selectedTopicId) ? selectedTopicId : visibleTopics[0]?.id ?? defaultTopicId;

  useEffect(() => {
    if (!visibleTopicIds.has(selectedTopicId)) {
      const fallbackTopic = visibleTopics[0];

      if (fallbackTopic) {
        setSelectedTopicId(fallbackTopic.id);
      }
    }
  }, [selectedTopicId, selectedTrackId, visibleTopicIds, visibleTopics]);

  useEffect(() => {
    setAdaptiveState(syncAdaptiveState(selectedTrackId));
  }, [selectedTrackId]);

  const selectedTopic = getTopic(activeTopicId);
  const selectedCategory = getCategory(selectedTopic.categoryId);
  const prerequisiteTopics = selectedTopic.prerequisites
    .map((topicId) => getTopic(topicId))
    .filter((topic) => topic.tracks.includes(selectedTrackId));
  const relatedTopics = selectedTopic.relatedTopics
    .map((topicId) => getTopic(topicId))
    .filter((topic) => topic.tracks.includes(selectedTrackId));

  function handleTopicSelection(topicId: string) {
    setSelectedTopicId(topicId);
    setIsMenuOpen(false);
  }

  function handleTrackSelection(trackId: CertificationTrackId) {
    setSelectedTrackId(trackId);
    setIsMenuOpen(false);
  }

  function handleStartReview(topicId: string) {
    handleTopicSelection(topicId);
    setReviewLaunchRequest((current) => ({
      launchId: (current?.launchId ?? 0) + 1,
      topicId,
    }));
  }

  function handleTopicQuizCompleted(record: StoredQuizResultRecord) {
    setAdaptiveState(recordTopicQuizResult(record));
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Certification-guided curriculum</p>
          <h1>AWS study shell for focused certification prep</h1>
        </div>
        <button
          type="button"
          className="menu-toggle"
          onClick={() => setIsMenuOpen((open) => !open)}
          aria-expanded={isMenuOpen}
          aria-controls="curriculum-sidebar"
        >
          {isMenuOpen ? 'Close curriculum' : 'Open curriculum'}
        </button>
      </header>

      <div className="app-shell">
        <div
          className={`mobile-backdrop ${isMenuOpen ? 'visible' : ''}`}
          onClick={() => setIsMenuOpen(false)}
          aria-hidden={!isMenuOpen}
        />

        <aside id="curriculum-sidebar" className={`sidebar ${isMenuOpen ? 'open' : ''}`}>
          <div className="sidebar-panel">
            <div className="sidebar-heading">
              <p className="eyebrow">Tracks</p>
              <h2>Choose your route</h2>
            </div>
            <div className="track-stack" role="tablist" aria-label="Certification tracks">
              {certificationTracks.map((track) => {
                const isActive = track.id === selectedTrackId;
                const visibleCount = getTopicsForTrack(track.id).length;

                return (
                  <button
                    key={track.id}
                    type="button"
                    className={`track-card ${isActive ? 'active' : ''}`}
                    onClick={() => handleTrackSelection(track.id)}
                    role="tab"
                    aria-selected={isActive}
                  >
                    <span className="track-level">{track.examLevel}</span>
                    <strong>{track.label}</strong>
                    <span>{track.description}</span>
                    <span className="track-count">{visibleCount} mapped topics</span>
                  </button>
                );
              })}
            </div>
          </div>

          <nav className="sidebar-panel" aria-label="AWS service categories">
            <div className="sidebar-heading">
              <p className="eyebrow">Curriculum map</p>
              <h2>Service categories</h2>
            </div>
            <div className="category-list">
              {visibleCategories.map((category) => {
                const categoryTopics = getTopicsForTrack(selectedTrackId, category.id);

                return (
                  <section key={category.id} className="category-group">
                    <header className="category-header">
                      <div>
                        <h3>{category.label}</h3>
                        <p>{category.summary}</p>
                      </div>
                      <span>{categoryTopics.length}</span>
                    </header>
                    <div className="topic-list">
                      {categoryTopics.map((topic) => {
                        const isSelected = topic.id === selectedTopic.id;

                        return (
                          <button
                            key={topic.id}
                            type="button"
                            className={`topic-button ${isSelected ? 'active' : ''}`}
                            onClick={() => handleTopicSelection(topic.id)}
                          >
                            <span>{topic.name}</span>
                            <small>{topic.examSignals[0]}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </nav>
        </aside>

        <main className="main-content">
          <section className="hero-panel">
            <div>
              <p className="eyebrow">Study shell</p>
              <h2>Two certification tracks, one shared AWS concept map</h2>
              <p className="hero-copy">
                Start with core services, see why each topic matters to a certification path, and follow the
                prerequisite chain before you move deeper into architecture decisions.
              </p>
            </div>
            <div className="hero-tracks">
              {certificationTracks.map((track) => {
                const isActive = track.id === selectedTrackId;

                return (
                  <button
                    key={track.id}
                    type="button"
                    className={`hero-track ${isActive ? 'active' : ''}`}
                    onClick={() => handleTrackSelection(track.id)}
                  >
                    <span>{track.examLevel}</span>
                    <strong>{track.label}</strong>
                  </button>
                );
              })}
            </div>
            <div className="outcomes-card">
              <p className="eyebrow">Selected track focus</p>
              <h3>{selectedTrack.label}</h3>
              <ul>
                {selectedTrack.outcomes.map((outcome) => (
                  <li key={outcome}>{outcome}</li>
                ))}
              </ul>
            </div>
          </section>

          <AdaptiveDashboard
            activeTopicId={selectedTopic.id}
            adaptiveState={adaptiveState}
            onSelectTopic={handleTopicSelection}
            onStartReview={handleStartReview}
            track={selectedTrack}
          />

          <article className="study-panel">
            <div className="topic-summary">
              <div>
                <p className="eyebrow">{selectedCategory.label}</p>
                <h2>{selectedTopic.name}</h2>
                <p className="topic-overview">{selectedTopic.overview}</p>
              </div>
              <div className="signal-card">
                <p className="eyebrow">Why it shows up on the exam</p>
                <ul>
                  {selectedTopic.examSignals.map((signal) => (
                    <li key={signal}>{signal}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="content-grid">
              <section className="content-card">
                <h3>Use cases</h3>
                <ul>
                  {selectedTopic.useCases.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>

              <section className="content-card">
                <h3>Trade-offs</h3>
                <ul>
                  {selectedTopic.tradeOffs.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>

              <section className="content-card">
                <h3>Operational notes</h3>
                <ul>
                  {selectedTopic.operationalNotes.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>

              <section className="content-card">
                <h3>Pricing notes</h3>
                <ul>
                  {selectedTopic.pricingNotes.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="best-practices-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Best-practice callouts</p>
                  <h3>AWS context tied to this topic</h3>
                </div>
              </div>
              <div className="best-practice-list">
                {selectedTopic.bestPracticeNotes.map((note) => (
                  <article key={`${selectedTopic.id}-${note.title}`} className="best-practice-note">
                    <h4>{note.title}</h4>
                    <p>{note.description}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="relationships-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Topic relationships</p>
                  <h3>What to learn before and after this topic</h3>
                </div>
              </div>
              <div className="relationship-columns">
                <div className="relationship-column">
                  <h4>Prerequisites</h4>
                  {prerequisiteTopics.length > 0 ? (
                    <div className="relationship-chip-list">
                      {prerequisiteTopics.map((topic) => (
                        <TopicLinkButton
                          key={`prerequisite-${topic.id}`}
                          label="Prerequisite"
                          topic={topic}
                          onSelect={handleTopicSelection}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="relationship-empty">This topic can be used as an entry point for the selected track.</p>
                  )}
                </div>

                <div className="relationship-column">
                  <h4>Study next</h4>
                  {relatedTopics.length > 0 ? (
                    <div className="relationship-chip-list">
                      {relatedTopics.map((topic) => (
                        <TopicLinkButton
                          key={`related-${topic.id}`}
                          label="Study next"
                          topic={topic}
                          onSelect={handleTopicSelection}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="relationship-empty">This topic is a strong checkpoint before moving into later associate-level topics.</p>
                  )}
                </div>
              </div>
            </section>

            <TutorPanel topic={selectedTopic} track={selectedTrack} />
            <QuizPanel
              topic={selectedTopic}
              track={selectedTrack}
              onTopicQuizCompleted={handleTopicQuizCompleted}
              reviewLaunchRequest={reviewLaunchRequest}
            />
          </article>
        </main>
      </div>
    </div>
  );
}
