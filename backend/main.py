from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import List, Optional
import enum

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text, asc, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker
from sqlalchemy.sql import func


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 10080
    cors_origins: str = "http://localhost:3000"
    environment: str = "development"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    @property
    def cors_origins_list(self) -> List[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode = {"sub": subject, "exp": expire}
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        return payload.get("sub")
    except JWTError:
        return None


engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class RecordType(str, enum.Enum):
    SCHOOL = "School"
    INTERMEDIATE = "Intermediate"
    COLLEGE = "College"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    records = relationship("AcademicRecord", back_populates="owner", cascade="all, delete-orphan")


class AcademicRecord(Base):
    __tablename__ = "academic_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    period: Mapped[str] = mapped_column(String(100), nullable=False)
    type: Mapped[RecordType] = mapped_column(Enum(RecordType), nullable=False)
    gpa: Mapped[float] = mapped_column(Float, nullable=False)
    marks: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    max_marks: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    owner = relationship("User", back_populates="records")


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def username_must_be_sensible(cls, v: str) -> str:
        v = v.strip()
        if not v.replace("_", "").replace("-", "").isalnum():
            raise ValueError("Username may only contain letters, numbers, hyphens, and underscores")
        return v


class UserLogin(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AcademicRecordBase(BaseModel):
    period: str = Field(min_length=1, max_length=100, examples=["Semester 3"])
    type: RecordType
    gpa: float = Field(ge=0, le=10)
    marks: Optional[float] = Field(default=None, ge=0)
    max_marks: Optional[float] = Field(default=None, gt=0)
    date: datetime
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("marks")
    @classmethod
    def marks_within_max(cls, v: Optional[float], info) -> Optional[float]:
        max_marks = info.data.get("max_marks")
        if v is not None and max_marks is not None and v > max_marks:
            raise ValueError("marks cannot exceed max_marks")
        return v


class AcademicRecordCreate(AcademicRecordBase):
    pass


class AcademicRecordUpdate(BaseModel):
    period: Optional[str] = Field(default=None, min_length=1, max_length=100)
    type: Optional[RecordType] = None
    gpa: Optional[float] = Field(default=None, ge=0, le=10)
    marks: Optional[float] = Field(default=None, ge=0)
    max_marks: Optional[float] = Field(default=None, gt=0)
    date: Optional[datetime] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class AcademicRecordOut(AcademicRecordBase):
    id: int
    user_id: int

    model_config = ConfigDict(from_attributes=True)


class TrendPoint(BaseModel):
    id: int
    period: str
    type: RecordType
    gpa: float
    date: datetime
    change_percent: Optional[float] = None
    direction: Optional[str] = None


class DashboardSummary(BaseModel):
    total_records: int
    current_gpa: Optional[float]
    highest_gpa: Optional[float]
    lowest_gpa: Optional[float]
    overall_change_percent: Optional[float]
    overall_direction: Optional[str]
    trend: List[TrendPoint]


class ComparisonEntry(BaseModel):
    label: str = Field(min_length=1, max_length=50, examples=["Friend A"])
    marks: float = Field(ge=0)
    max_marks: float = Field(gt=0)

    @property
    def percentage(self) -> float:
        return round((self.marks / self.max_marks) * 100, 2)


class ComparisonRequest(BaseModel):
    entries: List[ComparisonEntry] = Field(min_length=1, max_length=5)


class ComparisonResult(BaseModel):
    label: str
    marks: float
    max_marks: float
    percentage: float


def get_user_by_username(db: Session, username: str) -> Optional[User]:
    return db.query(User).filter(User.username == username).first()


def create_user(db: Session, user_in: UserCreate) -> User:
    user = User(username=user_in.username, hashed_password=hash_password(user_in.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def get_records_for_user(db: Session, user_id: int) -> List[AcademicRecord]:
    return (
        db.query(AcademicRecord)
        .filter(AcademicRecord.user_id == user_id)
        .order_by(asc(AcademicRecord.date))
        .all()
    )


def get_record(db: Session, record_id: int, user_id: int) -> Optional[AcademicRecord]:
    return (
        db.query(AcademicRecord)
        .filter(AcademicRecord.id == record_id, AcademicRecord.user_id == user_id)
        .first()
    )


def create_record(db: Session, record_in: AcademicRecordCreate, user_id: int) -> AcademicRecord:
    record = AcademicRecord(**record_in.model_dump(), user_id=user_id)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def update_record(db: Session, record: AcademicRecord, record_in: AcademicRecordUpdate) -> AcademicRecord:
    update_data = record_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(record, field, value)
    db.commit()
    db.refresh(record)
    return record


def delete_record(db: Session, record: AcademicRecord) -> None:
    db.delete(record)
    db.commit()


def _percent_change(previous: float, current: float) -> float:
    if previous == 0:
        return 0.0
    return round(((current - previous) / previous) * 100, 2)


def _direction(change: float) -> str:
    if change > 0:
        return "up"
    if change < 0:
        return "down"
    return "flat"


def build_dashboard_summary(records: List[AcademicRecord]) -> DashboardSummary:
    if not records:
        return DashboardSummary(
            total_records=0,
            current_gpa=None,
            highest_gpa=None,
            lowest_gpa=None,
            overall_change_percent=None,
            overall_direction=None,
            trend=[],
        )

    trend: List[TrendPoint] = []
    for i, record in enumerate(records):
        if i == 0:
            change_percent = None
            direction = None
        else:
            change_percent = _percent_change(records[i - 1].gpa, record.gpa)
            direction = _direction(change_percent)

        trend.append(
            TrendPoint(
                id=record.id,
                period=record.period,
                type=record.type,
                gpa=record.gpa,
                date=record.date,
                change_percent=change_percent,
                direction=direction,
            )
        )

    gpas = [r.gpa for r in records]
    overall_change = _percent_change(records[0].gpa, records[-1].gpa) if len(records) > 1 else None
    overall_direction = _direction(overall_change) if overall_change is not None else None

    return DashboardSummary(
        total_records=len(records),
        current_gpa=records[-1].gpa,
        highest_gpa=max(gpas),
        lowest_gpa=min(gpas),
        overall_change_percent=overall_change,
        overall_direction=overall_direction,
        trend=trend,
    )


COOKIE_NAME = "access_token"


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    credentials_exception = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    if token is None:
        raise credentials_exception

    username = decode_access_token(token)
    if username is None:
        raise credentials_exception

    user = get_user_by_username(db, username)
    if user is None:
        raise credentials_exception

    return user


app = FastAPI(
    title="Academic GPA Tracker API",
    version="1.0.0",
    description="Backend API for tracking academic GPA history over time.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _set_auth_cookie(response: Response, username: str) -> None:
    token = create_access_token(subject=username)
    max_age = settings.access_token_expire_minutes * 60
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        max_age=max_age,
        secure=settings.is_production,
        samesite="none" if settings.is_production else "lax",
        path="/",
    )


@app.post("/api/auth/register", response_model=UserOut, status_code=status.HTTP_201_CREATED, tags=["auth"])
def register(user_in: UserCreate, response: Response, db: Session = Depends(get_db)):
    existing = get_user_by_username(db, user_in.username)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is already taken")
    user = create_user(db, user_in)
    _set_auth_cookie(response, user.username)
    return user


@app.post("/api/auth/login", response_model=UserOut, tags=["auth"])
def login(credentials: UserLogin, response: Response, db: Session = Depends(get_db)):
    user = get_user_by_username(db, credentials.username)
    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect username or password")
    _set_auth_cookie(response, user.username)
    return user


@app.post("/api/auth/logout", status_code=status.HTTP_204_NO_CONTENT, tags=["auth"])
def logout(response: Response):
    response.delete_cookie(key=COOKIE_NAME, path="/")


@app.get("/api/auth/me", response_model=UserOut, tags=["auth"])
def read_current_user(current_user: User = Depends(get_current_user)):
    return current_user


@app.get("/api/records", response_model=List[AcademicRecordOut], tags=["records"])
def list_records(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return get_records_for_user(db, current_user.id)


@app.get("/api/records/dashboard", response_model=DashboardSummary, tags=["records"])
def dashboard(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    records = get_records_for_user(db, current_user.id)
    return build_dashboard_summary(records)


@app.post("/api/records", response_model=AcademicRecordOut, status_code=status.HTTP_201_CREATED, tags=["records"])
def add_record(
    record_in: AcademicRecordCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return create_record(db, record_in, current_user.id)


@app.patch("/api/records/{record_id}", response_model=AcademicRecordOut, tags=["records"])
def edit_record(
    record_id: int,
    record_in: AcademicRecordUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    record = get_record(db, record_id, current_user.id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    return update_record(db, record, record_in)


@app.delete("/api/records/{record_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["records"])
def remove_record(
    record_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    record = get_record(db, record_id, current_user.id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")
    delete_record(db, record)


@app.post("/api/compare", response_model=list[ComparisonResult], tags=["compare"])
def compare_marks(payload: ComparisonRequest, current_user: User = Depends(get_current_user)):
    return [
        ComparisonResult(label=e.label, marks=e.marks, max_marks=e.max_marks, percentage=e.percentage)
        for e in payload.entries
    ]


@app.get("/")
def root():
    return {"status": "ok", "service": "Academic GPA Tracker API"}


@app.get("/health")
def health_check():
    return {"status": "healthy"}
